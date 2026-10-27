package servercert

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNativeTLSKeepsCAAcrossRestartAddressChangeAndRenewal(t *testing.T) {
	dir := t.TempDir()
	m, e := New(dir, "127.0.0.1")
	if e != nil {
		t.Fatal(e)
	}
	root := m.PublicCA()
	first, _ := m.Certificate(nil)
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(root) {
		t.Fatal("invalid public CA")
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: m.Certificate, Certificates: []tls.Certificate{*first}}
	server.StartTLS()
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: "127.0.0.1"}}}
	response, e := client.Get(server.URL)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	again, e := New(dir, "127.0.0.1")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(again.PublicCA(), root) {
		t.Fatal("restart changed CA")
	}
	if e = m.SetHost("192.0.2.7"); e != nil {
		t.Fatal(e)
	}
	changed, _ := m.Certificate(nil)
	if e = changed.Leaf.VerifyHostname("192.0.2.7"); e != nil {
		t.Fatal(e)
	}
	if bytes.Equal(changed.Certificate[0], first.Certificate[0]) || !bytes.Equal(root, m.PublicCA()) {
		t.Fatal("host change did not preserve trust")
	}
	os.Remove(filepath.Join(dir, "tls/fullchain.pem"))
	if e = m.Refresh(); e != nil {
		t.Fatal(e)
	}
	renewed, _ := m.Certificate(nil)
	if _, e = renewed.Leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "192.0.2.7"}); e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(root, m.PublicCA()) {
		t.Fatal("renewal changed CA")
	}
	reloaded, e := New(dir, "ignored.example")
	if e != nil || reloaded.View().Host != "192.0.2.7" {
		t.Fatal("saved address was not retained", e)
	}
	info, e := os.Stat(filepath.Join(dir, "tls/authority/ca.key"))
	if e != nil {
		t.Fatal(e)
	}
	if info.Mode().Perm() != 0600 && os.PathSeparator != '\\' {
		t.Fatal("CA key not private")
	}
}
func TestDownloadMaterialCannotContainPrivateKey(t *testing.T) {
	dir := t.TempDir()
	m, e := New(dir, "localhost")
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(dir, "tls/authority/ca.crt")
	private, e := os.ReadFile(filepath.Join(dir, "tls/authority/ca.key"))
	if e != nil {
		t.Fatal(e)
	}
	os.WriteFile(path, append(m.PublicCA(), private...), 0600)
	m, e = New(dir, "localhost")
	if e != nil {
		t.Fatal(e)
	}
	block, rest := pem.Decode(m.PublicCA())
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 || bytes.Contains(m.PublicCA(), []byte("PRIVATE KEY")) {
		t.Fatal("private material exposed")
	}
}
func TestInvalidAddressAndWrongCertificateDoNotChangeConnection(t *testing.T) {
	m, e := New(t.TempDir(), "localhost")
	if e != nil {
		t.Fatal(e)
	}
	for _, host := range []string{"", "https://site", "site:8090", "bad\nsite", "-site"} {
		if e = m.SetHost(host); e == nil {
			t.Fatal("accepted invalid host")
		}
	}
	if e = m.Install([]byte("invalid"), []byte("invalid")); e == nil {
		t.Fatal("accepted invalid certificate")
	}
	if m.View().Host != "localhost" || m.View().Mode != "auto" || time.Until(m.View().ExpiresAt) < time.Hour {
		t.Fatal("invalid input changed active TLS")
	}
}

func TestPublicBundleValidatesHostChainAndKeepsActivePairOnBadReplacement(t *testing.T) {
	dir := t.TempDir()
	manager, err := New(dir, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	before, _ := manager.Certificate(nil)
	cert, _ := os.ReadFile(filepath.Join(dir, "tls/fullchain.pem"))
	key, _ := os.ReadFile(filepath.Join(dir, "tls/privkey.pem"))
	raw, _ := json.Marshal(map[string]string{"host": "127.0.0.1", "certificate": string(cert), "privateKey": string(key)})
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(manager.PublicCA())
	if _, err = verifiedPublicPair(raw, "127.0.0.1", roots); err != nil {
		t.Fatal(err)
	}
	if _, err = verifiedPublicPair(raw, "192.0.2.1", roots); err == nil {
		t.Fatal("wrong IP accepted")
	}
	if _, err = verifiedPublicPair(raw, "127.0.0.1", x509.NewCertPool()); err == nil {
		t.Fatal("untrusted chain accepted")
	}
	if err = os.WriteFile(filepath.Join(dir, "tls/public.json"), []byte("malformed"), 0600); err != nil {
		t.Fatal(err)
	}
	after, _ := manager.Certificate(nil)
	if !bytes.Equal(before.Certificate[0], after.Certificate[0]) {
		t.Fatal("invalid replacement broke active certificate")
	}
	if _, err = New(dir, "127.0.0.1"); err == nil {
		t.Fatal("startup silently fell back after invalid public certificate")
	}
}
