package dispatcher

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"time"
)

var releaseVersion = regexp.MustCompile(`^worker-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// The host updater exposes a narrow Unix API. The application never receives a Docker socket.
func (h *HTTP) updaterCall(ctx context.Context, method, path string, body any) (json.RawMessage, int, error) {
	socket := os.Getenv("DISPATCHER_UPDATER_SOCKET")
	if socket == "" {
		return nil, 0, problem(409, "UPDATER_DISABLED", "Updater is not installed")
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	req, err := http.NewRequestWithContext(ctx, method, "http://updater"+path, bytes.NewReader(raw))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return nil, 0, problem(503, "UPDATER_UNAVAILABLE", "Host updater is unavailable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(data) > 65536 || !json.Valid(data) {
		return nil, 0, problem(502, "UPDATER_UNAVAILABLE", "Invalid updater response")
	}
	if response.StatusCode != 200 && response.StatusCode != 202 {
		return nil, 0, problem(409, "UPDATE_REJECTED", "Update request rejected")
	}
	return data, response.StatusCode, nil
}

func (h *HTTP) adminUpdates(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if err := requireOwner(a); err != nil {
		h.failure(w, err)
		return
	}
	if os.Getenv("DISPATCHER_UPDATER_SOCKET") == "" {
		h.reply(w, 200, map[string]any{"enabled": false, "phase": "disabled", "message": "Служба обновления не установлена"})
		return
	}
	data, status, err := h.updaterCall(r.Context(), "GET", "/status", nil)
	if err != nil {
		h.failure(w, err)
		return
	}
	h.reply(w, status, data)
}
func (h *HTTP) adminUpdateCheck(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if err := requireOwner(a); err != nil {
		h.failure(w, err)
		return
	}
	data, status, err := h.updaterCall(r.Context(), "POST", "/check", map[string]any{})
	if err != nil {
		h.failure(w, err)
		return
	}
	h.reply(w, status, data)
}
func (h *HTTP) adminUpdateInstall(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if err := requireOwner(a); err != nil {
		h.failure(w, err)
		return
	}
	var input struct {
		Version string `json:"version"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2049))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || !releaseVersion.MatchString(input.Version) {
		h.failure(w, problem(400, "INVALID_REQUEST", "Release version is required"))
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		h.failure(w, problem(400, "INVALID_REQUEST", "Invalid request"))
		return
	}
	data, status, err := h.updaterCall(r.Context(), "POST", "/install", map[string]any{"version": input.Version})
	if err != nil {
		h.failure(w, err)
		return
	}
	h.reply(w, status, data)
}
