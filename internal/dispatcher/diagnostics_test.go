package dispatcher

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func diagHandler(t *testing.T) (*Store, *ErrorStore, http.Handler) {
	t.Helper()
	s, _, _ := openTest(t)
	es, _ := openErrorsTest(t)
	h := Handler(s).(*HTTP)
	h.ConfigureErrors(es)
	return s, es, h
}

func postDiagnostics(t *testing.T, h http.Handler, token string, batch DiagnosticsBatch) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v2/site/diagnostics/events", bytes.NewReader(encode(batch)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestDiagnosticsIngressAcceptsSiteBatch(t *testing.T) {
	s, es, h := diagHandler(t)
	site, err := s.CreateSite(testContext, "diag", 1, []string{"diagnostics.collect"})
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := s.IssueToken(testContext, "SITE", site.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec := postDiagnostics(t, h, token, DiagnosticsBatch{ProtocolVersion: "2.0", Events: []DiagnosticsEvent{testDiagEvent()}})
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var ack struct {
		Accepted   int    `json:"accepted"`
		Duplicates int    `json:"duplicates"`
		ReceivedAt string `json:"receivedAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil {
		t.Fatal(err)
	}
	if ack.Accepted != 1 || ack.Duplicates != 0 {
		t.Fatalf("ack = %+v", ack)
	}
	var groups int
	if err := es.db.QueryRow("SELECT count(*) FROM error_groups WHERE area='sites' AND site_id=?", site.ID).Scan(&groups); err != nil {
		t.Fatal(err)
	}
	if groups != 1 {
		t.Fatalf("expected 1 group, got %d", groups)
	}
}

func TestDiagnosticsIngressRejectsWithoutPermission(t *testing.T) {
	s, _, h := diagHandler(t)
	site, err := s.CreateSite(testContext, "diag", 1, []string{"media.transcode"})
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := s.IssueToken(testContext, "SITE", site.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec := postDiagnostics(t, h, token, DiagnosticsBatch{ProtocolVersion: "2.0", Events: []DiagnosticsEvent{testDiagEvent()}})
	if rec.Code != 403 {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestDiagnosticsIngressRejectsWorkerSource(t *testing.T) {
	s, _, h := diagHandler(t)
	site, err := s.CreateSite(testContext, "diag", 1, []string{"diagnostics.collect"})
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := s.IssueToken(testContext, "SITE", site.ID)
	if err != nil {
		t.Fatal(err)
	}
	ev := testDiagEvent()
	ev.Source = "worker"
	rec := postDiagnostics(t, h, token, DiagnosticsBatch{ProtocolVersion: "2.0", Events: []DiagnosticsEvent{ev}})
	if rec.Code != 403 {
		t.Fatalf("expected 403 for worker source, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestDeviceDiagnosticsIngress(t *testing.T) {
	s, es, handler := diagHandler(t)
	h := handler.(*HTTP)
	s.now = time.Now
	device, err := s.CreateDevice(testContext, "diag-box", testCaps())
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := s.IssueToken(testContext, "DEVICE", device.ID)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h)
	defer server.Close()
	defer h.CloseDevices()
	c := wsDial(t, server.URL, token)
	wsHello(t, c, device.ID, nil)
	_ = wsRead(t, c, "catalog.offer")
	ev := testDiagEvent()
	ev.Source = "worker"
	ev.Service = "processor"
	ev.Code = "EXECUTOR_FAILED"
	wsSend(t, c, "diagnostics.events", UUID(), map[string]any{"events": []DiagnosticsEvent{ev}})
	ack := wsRead(t, c, "diagnostics.ack")
	var body struct {
		Accepted   int `json:"accepted"`
		Duplicates int `json:"duplicates"`
	}
	if err := json.Unmarshal(ack.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body.Accepted != 1 {
		t.Fatalf("ack = %+v", body)
	}
	var area string
	if err := es.db.QueryRow("SELECT area FROM error_events WHERE sender_id=?", device.ID).Scan(&area); err != nil {
		t.Fatal(err)
	}
	if area != "worker" {
		t.Fatalf("area = %s", area)
	}
}

func TestAdminDiagnosticsProbeAndStatus(t *testing.T) {
	s, es, h := diagHandler(t)
	if err := s.BootstrapOwner(testContext, "owner", "owner-password-1"); err != nil {
		t.Fatal(err)
	}
	site, err := s.CreateSite(testContext, "diag", 1, []string{"diagnostics.collect"})
	if err != nil {
		t.Fatal(err)
	}
	sender := DiagnosticsSender{ID: site.ID, Area: "sites", SiteID: site.ID}
	if _, _, err := es.Record(testContext, sender, []DiagnosticsEvent{testDiagEvent()}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	client, sess := login(t, srv, "owner", "owner-password-1")
	csrf := sess["csrfToken"].(string)
	resp := adminDo(t, client, "POST", srv.URL+"/api/v2/admin/sites/"+site.ID+"/diagnostics/probe", csrf, map[string]any{})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("probe %d", resp.StatusCode)
	}
	var probe map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&probe); err != nil {
		t.Fatal(err)
	}
	if probe["ok"] != true || probe["collectionEnabled"] != true || probe["lastReceivedAt"] == nil {
		t.Fatalf("probe = %+v", probe)
	}
	st := adminDo(t, client, "GET", srv.URL+"/api/v2/admin/diagnostics/status", "", nil)
	defer st.Body.Close()
	if st.StatusCode != 200 {
		t.Fatalf("status %d", st.StatusCode)
	}
}

func TestCapabilitiesOmitsDiagnosticsCollect(t *testing.T) {
	s, _, h := diagHandler(t)
	site, err := s.CreateSite(testContext, "diag", 1, []string{
		"media.transcode", "media.transcribe", "media.subtitles", "media.generate", "diagnostics.collect",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := s.IssueToken(testContext, "SITE", site.ID)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v2/site/capabilities", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if err := s.validator.Check("Capabilities", rec.Body.Bytes()); err != nil {
		t.Fatal(err)
	}
	var body struct {
		DiagnosticsCollect bool `json:"diagnosticsCollect"`
		Operations         []struct {
			Code string `json:"code"`
		} `json:"operations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.DiagnosticsCollect {
		t.Fatal("expected diagnosticsCollect")
	}
	for _, op := range body.Operations {
		if op.Code == "diagnostics.collect" {
			t.Fatal("diagnostics.collect must not appear in the compute catalogue")
		}
	}
}
