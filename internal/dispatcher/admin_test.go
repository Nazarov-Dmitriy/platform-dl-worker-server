package dispatcher

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"testing"
)

func adminServer(t *testing.T) (*httptest.Server, *Store) {
	t.Helper()
	s, _, _ := openTest(t)
	if e := s.BootstrapOwner(testContext, "owner", "owner-password-1"); e != nil {
		t.Fatal(e)
	}
	h := Handler(s)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, s
}
func login(t *testing.T, srv *httptest.Server, login, password string) (*http.Client, map[string]any) {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	raw, _ := json.Marshal(map[string]string{"login": login, "password": password})
	resp, e := c.Post(srv.URL+"/api/v2/admin/session", "application/json", bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	var sess map[string]any
	json.NewDecoder(resp.Body).Decode(&sess)
	if resp.StatusCode != 200 {
		t.Fatalf("login %d %+v", resp.StatusCode, sess)
	}
	return c, sess
}
func adminDo(t *testing.T, c *http.Client, method, rawURL, csrf string, body any) *http.Response {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, e := http.NewRequest(method, rawURL, rdr)
	if e != nil {
		t.Fatal(e)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if csrf != "" && method != "GET" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	resp, e := c.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	return resp
}

func TestAdminOperatorCannotIssueDeviceTokenOrManageAccounts(t *testing.T) {
	srv, s := adminServer(t)
	owner, sess := login(t, srv, "owner", "owner-password-1")
	csrf := sess["csrfToken"].(string)
	acc := adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/accounts", csrf, map[string]any{
		"login": "operator1", "password": "operator-pass-1", "enabled": true, "role": "OPERATOR", "manageSites": false,
	})
	if acc.StatusCode != 201 {
		t.Fatal(acc.Status)
	}
	acc.Body.Close()
	dev := adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/devices", csrf, map[string]any{"name": "box", "enabled": true})
	if dev.StatusCode != 201 {
		t.Fatal(dev.Status)
	}
	var created map[string]any
	json.NewDecoder(dev.Body).Decode(&created)
	dev.Body.Close()
	op, opSess := login(t, srv, "operator1", "operator-pass-1")
	opCSRF := opSess["csrfToken"].(string)
	if opSess["role"] != "OPERATOR" || opSess["manageSites"] != false {
		t.Fatalf("%+v", opSess)
	}
	forbid := adminDo(t, op, "POST", srv.URL+"/api/v2/admin/accounts", opCSRF, map[string]any{
		"login": "x", "password": "operator-pass-2", "enabled": true, "role": "OPERATOR", "manageSites": false,
	})
	if forbid.StatusCode != 403 {
		t.Fatal(forbid.Status)
	}
	forbid.Body.Close()
	tok := adminDo(t, op, "POST", srv.URL+"/api/v2/admin/devices/"+created["id"].(string)+"/tokens", opCSRF, map[string]any{"requestId": UUID()})
	if tok.StatusCode != 403 {
		t.Fatal(tok.Status)
	}
	tok.Body.Close()
	list, e := http.NewRequest("GET", srv.URL+"/api/v2/admin/tokens", nil)
	if e != nil {
		t.Fatal(e)
	}
	resp, e := op.Do(list)
	if e != nil {
		t.Fatal(e)
	}
	var page map[string]any
	json.NewDecoder(resp.Body).Decode(&page)
	resp.Body.Close()
	items := page["items"].([]any)
	for _, item := range items {
		if item.(map[string]any)["purpose"] == "DEVICE" {
			t.Fatal("operator saw a device token")
		}
	}
	offline := created["online"]
	if offline != false {
		t.Fatalf("disconnected device looked online: %+v", created)
	}
	_ = s
}

func TestAdminLoginRateLimit(t *testing.T) {
	srv, _ := adminServer(t)
	for i := 0; i < 5; i++ {
		raw, _ := json.Marshal(map[string]string{"login": "owner", "password": "wrong-password-x"})
		resp, e := http.Post(srv.URL+"/api/v2/admin/session", "application/json", bytes.NewReader(raw))
		if e != nil {
			t.Fatal(e)
		}
		if resp.StatusCode != 401 {
			t.Fatal(resp.Status)
		}
		resp.Body.Close()
	}
	raw, _ := json.Marshal(map[string]string{"login": "owner", "password": "wrong-password-x"})
	resp, e := http.Post(srv.URL+"/api/v2/admin/session", "application/json", bytes.NewReader(raw))
	if e != nil || resp.StatusCode != 429 {
		t.Fatalf("rate limit: %v %d", e, resp.StatusCode)
	}
	resp.Body.Close()
}

func TestAdminSiteTokenOnceAndPanel(t *testing.T) {
	srv, _ := adminServer(t)
	owner, sess := login(t, srv, "owner", "owner-password-1")
	csrf := sess["csrfToken"].(string)
	site := adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/sites", csrf, map[string]any{
		"name": "courses", "enabled": true, "weight": 4, "operations": []string{"media.transcode"},
	})
	if site.StatusCode != 201 {
		t.Fatal(site.Status)
	}
	var view map[string]any
	json.NewDecoder(site.Body).Decode(&view)
	site.Body.Close()
	reqID := UUID()
	first := adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/sites/"+view["id"].(string)+"/tokens", csrf, map[string]any{"requestId": reqID})
	if first.StatusCode != 201 {
		t.Fatal(first.Status)
	}
	var issued map[string]any
	json.NewDecoder(first.Body).Decode(&issued)
	first.Body.Close()
	if issued["token"] == nil || len(issued["token"].(string)) < 32 {
		t.Fatal(issued)
	}
	again := adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/sites/"+view["id"].(string)+"/tokens", csrf, map[string]any{"requestId": reqID})
	if again.StatusCode != 409 {
		t.Fatal(again.Status)
	}
	again.Body.Close()
	noCSRF := adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/devices", "", map[string]any{"name": "x", "enabled": true})
	if noCSRF.StatusCode != 403 {
		t.Fatal(noCSRF.Status)
	}
	noCSRF.Body.Close()
	page, e := owner.Get(srv.URL + "/panel/")
	if e != nil || page.StatusCode != 200 {
		t.Fatal(e, page)
	}
	page.Body.Close()
}

func TestAdminResetOwnerPasswordInvalidatesSession(t *testing.T) {
	srv, s := adminServer(t)
	_, _ = login(t, srv, "owner", "owner-password-1")
	if e := s.ResetOwnerPassword(testContext, "owner", "new-owner-pass1"); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(map[string]string{"login": "owner", "password": "owner-password-1"})
	resp, _ := http.Post(srv.URL+"/api/v2/admin/session", "application/json", bytes.NewReader(raw))
	if resp.StatusCode != 401 {
		t.Fatal(resp.Status)
	}
	resp.Body.Close()
	_, sess := login(t, srv, "owner", "new-owner-pass1")
	if sess["role"] != "OWNER" {
		t.Fatal(sess)
	}
	u, _ := url.Parse(srv.URL)
	_ = u
}
