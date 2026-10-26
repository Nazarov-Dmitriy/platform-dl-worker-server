package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"titunki/worker-server/internal/dispatcher"
	"titunki/worker-server/internal/servercert"
)

func bootstrapContainerOwner(store *dispatcher.Store, dir string) error {
	login := os.Getenv("DISPATCHER_OWNER")
	if login == "" {
		login = "owner"
	}
	passwordPath := filepath.Join(dir, "initial-owner-password")
	bootstrapPath := filepath.Join(dir, ".bootstrap-password")
	raw, e := os.ReadFile(bootstrapPath)
	fromInput := e == nil
	created := false
	if os.IsNotExist(e) {
		raw, e = os.ReadFile(passwordPath)
		if os.IsNotExist(e) {
			var bytes [24]byte
			if _, e = rand.Read(bytes[:]); e != nil {
				return e
			}
			raw = []byte(hex.EncodeToString(bytes[:]))
			if e = os.WriteFile(passwordPath, append(raw, '\n'), 0600); e != nil {
				return e
			}
			created = true
		} else if e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	password := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
	if len(password) < 12 || strings.ContainsAny(password, "\r\n\x00") {
		return errors.New("bootstrap password must contain at least 12 characters on one line")
	}
	e = store.BootstrapOwner(context.Background(), login, password)
	var api *dispatcher.APIError
	if e != nil && (!errors.As(e, &api) || api.Code != "ALREADY_INITIALIZED") {
		return e
	}
	if e != nil && created {
		_ = os.Remove(passwordPath)
	}
	if fromInput {
		if removeErr := os.Remove(bootstrapPath); removeErr != nil {
			return removeErr
		}
	}
	return nil
}
func checkHealth(dir, listen, host string) error {
	raw, e := os.ReadFile(filepath.Join(dir, "connection.json"))
	if e == nil {
		var saved servercert.Settings
		if e = json.Unmarshal(raw, &saved); e != nil {
			return e
		}
		host = saved.Host
	}
	if !servercert.ValidHost(host) {
		return errors.New("public address is not configured")
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	raw, e = os.ReadFile(filepath.Join(dir, "device-ca.crt"))
	if e != nil {
		return e
	}
	if !roots.AppendCertsFromPEM(raw) {
		return errors.New("invalid CA")
	}
	_, port, e := net.SplitHostPort(listen)
	if e != nil {
		return e
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: host}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	response, e := client.Get("https://" + net.JoinHostPort(host, port) + "/readyz")
	if e != nil {
		return errors.New("dispatcher TLS readiness check failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusOK {
		return errors.New("dispatcher is not ready")
	}
	return nil
}
