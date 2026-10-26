package dispatcher

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestUpdaterOwnerOnlyCSRFAndVersionValidation(t *testing.T) {
	t.Setenv("DISPATCHER_UPDATER_SOCKET", "")
	srv, _ := adminServer(t)
	owner, session := login(t, srv, "owner", "owner-password-1")
	csrf := session["csrfToken"].(string)
	response := adminDo(t, http.DefaultClient, "GET", srv.URL+"/api/v2/admin/updates", "", nil)
	if response.StatusCode != 401 {
		t.Fatal(response.Status)
	}
	response.Body.Close()
	response = adminDo(t, owner, "GET", srv.URL+"/api/v2/admin/updates", "", nil)
	if response.StatusCode != 200 {
		t.Fatal(response.Status)
	}
	response.Body.Close()
	response = adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/updates/check", "", map[string]any{})
	if response.StatusCode != 403 {
		t.Fatal(response.Status)
	}
	response.Body.Close()
	for _, version := range []string{"latest", "worker-v1.2.3;command", "worker-v1.2", "worker-v01.2.3"} {
		response = adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/updates/install", csrf, map[string]any{"version": version})
		if response.StatusCode != 400 {
			t.Fatalf("%s: %s", version, response.Status)
		}
		response.Body.Close()
	}
	response = adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/accounts", csrf, map[string]any{"login": "updater-operator", "password": "operator-pass-1", "enabled": true, "role": "OPERATOR", "manageSites": false})
	response.Body.Close()
	operator, opSession := login(t, srv, "updater-operator", "operator-pass-1")
	for _, path := range []string{"", "/check", "/install"} {
		method := "POST"
		if path == "" {
			method = "GET"
		}
		response = adminDo(t, operator, method, srv.URL+"/api/v2/admin/updates"+path, opSession["csrfToken"].(string), map[string]any{"version": "worker-v1.0.0"})
		if response.StatusCode != 403 {
			t.Fatal(response.Status)
		}
		response.Body.Close()
	}
}

func TestUpdaterProxySendsOnlyVersionAndNeverDockerSocket(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix socket integration runs in Linux CI")
	}
	directory, err := os.MkdirTemp("", "worker-socket-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	socket := filepath.Join(directory, "update.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan map[string]any, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/install" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		received <- body
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(202)
		w.Write([]byte(`{"enabled":true,"phase":"downloading"}`))
	})}
	go server.Serve(listener)
	defer server.Close()
	t.Setenv("DISPATCHER_UPDATER_SOCKET", socket)
	srv, store := adminServer(t)
	owner, session := login(t, srv, "owner", "owner-password-1")
	response := adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/updates/install", session["csrfToken"].(string), map[string]any{"version": "worker-v1.2.3"})
	if response.StatusCode != 202 {
		t.Fatal(response.Status)
	}
	response.Body.Close()
	body := <-received
	if body["version"] != "worker-v1.2.3" || len(body) != 1 {
		t.Fatalf("%v", body)
	}
	status, err := store.OpsStatus(testContext)
	if err != nil || status.Maintenance {
		t.Fatal("proxy changed maintenance before host accepted update")
	}
}
