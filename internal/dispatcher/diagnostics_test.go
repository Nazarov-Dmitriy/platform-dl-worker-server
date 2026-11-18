package dispatcher

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
