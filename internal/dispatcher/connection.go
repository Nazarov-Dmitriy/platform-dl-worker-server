package dispatcher

import (
	"encoding/json"
	"net/http"
	"titunki/worker-server/internal/servercert"
)

func (h *HTTP) ConfigureConnection(manager *servercert.Manager) { h.certificates = manager }
func (h *HTTP) connectionCertificate(w http.ResponseWriter, r *http.Request) {
	if h.certificates == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="device-ca.crt"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(h.certificates.PublicCA())
}
func (h *HTTP) adminConnection(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if e := requireOwner(a); e != nil {
		h.failure(w, e)
		return
	}
	if h.certificates == nil {
		h.failure(w, problem(409, "BUILT_IN_TLS_DISABLED", "Built-in TLS is not enabled"))
		return
	}
	h.reply(w, 200, h.certificates.View())
}
func (h *HTTP) adminConnectionSet(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if e := requireOwner(a); e != nil {
		h.failure(w, e)
		return
	}
	if h.certificates == nil {
		h.failure(w, problem(409, "BUILT_IN_TLS_DISABLED", "Built-in TLS is not enabled"))
		return
	}
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	var input struct {
		Host string `json:"host"`
	}
	if e = json.Unmarshal(raw, &input); e != nil {
		h.failure(w, problem(400, "INVALID_REQUEST", "Invalid connection configuration"))
		return
	}
	if e = h.certificates.SetHost(input.Host); e != nil {
		h.failure(w, problem(400, "INVALID_CONNECTION", e.Error()))
		return
	}
	h.reply(w, 200, h.certificates.View())
}

func (h *HTTP) adminPublicCertificate(w http.ResponseWriter, r *http.Request, actor AdminActor) {
	if err := requireOwner(actor); err != nil {
		h.failure(w, err)
		return
	}
	data, code, err := h.updaterCall(r.Context(), "GET", "/certificate", nil)
	if err != nil {
		h.failure(w, err)
		return
	}
	h.reply(w, code, data)
}
func (h *HTTP) adminEnablePublicCertificate(w http.ResponseWriter, r *http.Request, actor AdminActor) {
	if err := requireOwner(actor); err != nil {
		h.failure(w, err)
		return
	}
	if h.certificates == nil || h.certificates.View().Mode == "manual" {
		h.failure(w, problem(409, "INVALID_CONNECTION", "Switch to automatic certificate mode first"))
		return
	}
	data, code, err := h.updaterCall(r.Context(), "POST", "/certificate", map[string]any{})
	if err != nil {
		h.failure(w, err)
		return
	}
	h.reply(w, code, data)
}
