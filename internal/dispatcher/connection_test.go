package dispatcher

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"titunki/worker-server/internal/servercert"
)

func TestPublicCertificateDownloadDoesNotRequireLoginOrExposeKey(t *testing.T) {
	store, _, _ := openTest(t)
	manager, e := servercert.New(t.TempDir(), "127.0.0.1")
	if e != nil {
		t.Fatal(e)
	}
	handler := Handler(store).(*HTTP)
	handler.ConfigureConnection(manager)
	srv := httptest.NewServer(handler)
	defer srv.Close()
	response, e := http.Get(srv.URL + "/device-ca.crt")
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || !bytes.Equal(raw, manager.PublicCA()) || bytes.Contains(raw, []byte("PRIVATE KEY")) {
		t.Fatal("invalid certificate download")
	}
	if response.Header.Get("Content-Disposition") != `attachment; filename="device-ca.crt"` {
		t.Fatal("download filename not set")
	}
	response2, e := http.Get(srv.URL + "/api/v2/admin/connection")
	if e != nil {
		t.Fatal(e)
	}
	response2.Body.Close()
	if response2.StatusCode != 401 {
		t.Fatal("connection settings are public")
	}
}
