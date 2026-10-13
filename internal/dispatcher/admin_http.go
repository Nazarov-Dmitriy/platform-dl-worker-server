package dispatcher

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"titunki/worker-server/panel"
)

const sessionCookie = "dispatcher_session"

func (h *HTTP) addAdminRoutes() {
	h.mux.HandleFunc("POST /api/v2/admin/session", h.adminLogin)
	h.mux.HandleFunc("GET /api/v2/admin/session", h.admin(h.adminSession, false))
	h.mux.HandleFunc("DELETE /api/v2/admin/session", h.admin(h.adminLogout, false))
	h.mux.HandleFunc("POST /api/v2/admin/sites", h.admin(h.adminCreateSite, true))
	h.mux.HandleFunc("GET /api/v2/admin/sites", h.admin(h.adminListSites, false))
	h.mux.HandleFunc("PUT /api/v2/admin/sites/{id}", h.admin(h.adminUpdateSite, true))
	h.mux.HandleFunc("POST /api/v2/admin/sites/{id}/tokens", h.admin(h.adminIssueSiteToken, true))
	h.mux.HandleFunc("GET /api/v2/admin/jobs", h.admin(h.adminJobs, false))
	h.mux.HandleFunc("POST /api/v2/admin/sites/{id}/jobs/{jobId}/cancel", h.admin(h.adminCancelJob, true))
	h.mux.HandleFunc("POST /api/v2/admin/sites/{id}/cancel-all", h.admin(h.adminCancelAll, true))
	h.mux.HandleFunc("POST /api/v2/admin/devices", h.admin(h.adminCreateDevice, true))
	h.mux.HandleFunc("GET /api/v2/admin/devices", h.admin(h.adminListDevices, false))
	h.mux.HandleFunc("PUT /api/v2/admin/devices/{id}", h.admin(h.adminUpdateDevice, true))
	h.mux.HandleFunc("POST /api/v2/admin/devices/{id}/tokens", h.admin(h.adminIssueDeviceToken, true))
	h.mux.HandleFunc("POST /api/v2/admin/devices/{id}/commands", h.admin(h.adminCommand, true))
	h.mux.HandleFunc("GET /api/v2/admin/devices/{id}/commands/{requestId}", h.admin(h.adminCommandGet, false))
	h.mux.HandleFunc("GET /api/v2/admin/devices/{id}/settings", h.admin(h.adminDeviceSettings, false))
	h.mux.HandleFunc("GET /api/v2/admin/devices/{id}/models", h.admin(h.adminDeviceModels, false))
	h.mux.HandleFunc("POST /api/v2/admin/accounts", h.admin(h.adminCreateAccount, true))
	h.mux.HandleFunc("GET /api/v2/admin/accounts", h.admin(h.adminListAccounts, false))
	h.mux.HandleFunc("PUT /api/v2/admin/accounts/{id}", h.admin(h.adminUpdateAccount, true))
	h.mux.HandleFunc("POST /api/v2/admin/tokens/{id}/revoke", h.admin(h.adminRevokeToken, true))
	h.mux.HandleFunc("GET /api/v2/admin/tokens", h.admin(h.adminListTokens, false))
	h.mux.HandleFunc("GET /api/v2/admin/models", h.admin(h.adminModels, false))
	h.mux.HandleFunc("GET /api/v2/admin/audit", h.admin(h.adminAudit, false))
	h.mux.Handle("GET /panel/", http.StripPrefix("/panel/", http.FileServer(http.FS(panel.Files))))
	h.mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/panel/", http.StatusFound)
	})
}

func (h *HTTP) admin(next func(http.ResponseWriter, *http.Request, AdminActor), mutate bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, e := r.Cookie(sessionCookie)
		secret := ""
		if e == nil {
			secret = c.Value
		}
		a, csrf, e := h.store.LookupSession(r.Context(), secret)
		if e != nil {
			h.failure(w, e)
			return
		}
		if mutate && r.Header.Get("X-CSRF-Token") != csrf {
			h.failure(w, problem(403, "CSRF_REJECTED", "CSRF token is missing or invalid"))
			return
		}
		next(w, r, a)
	}
}
func (h *HTTP) adminLogin(w http.ResponseWriter, r *http.Request) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i > 0 {
		ip = ip[:i]
	}
	rec, e := h.store.Login(r.Context(), ip, raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	secure := r.TLS != nil
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: rec.Secret, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: secure, Expires: time.Now().Add(sessionTTL),
	})
	h.reply(w, 200, rec.View)
}
func (h *HTTP) adminSession(w http.ResponseWriter, r *http.Request, a AdminActor) {
	_, csrf, _ := h.store.LookupSession(r.Context(), cookieSecret(r))
	h.reply(w, 200, h.store.SessionView(a, csrf))
}
func (h *HTTP) adminLogout(w http.ResponseWriter, r *http.Request, a AdminActor) {
	_ = h.store.Logout(r.Context(), cookieSecret(r))
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", MaxAge: -1, HttpOnly: true})
	w.WriteHeader(204)
}
func cookieSecret(r *http.Request) string {
	c, e := r.Cookie(sessionCookie)
	if e != nil {
		return ""
	}
	return c.Value
}
func (h *HTTP) adminCreateSite(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminCreateSite(r.Context(), a, raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 201, v)
}
func (h *HTTP) adminListSites(w http.ResponseWriter, r *http.Request, a AdminActor) {
	v, e := h.store.AdminListSites(r.Context(), a)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminUpdateSite(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminUpdateSite(r.Context(), a, r.PathValue("id"), r.Header.Get("If-Match"), raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminIssueSiteToken(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminIssueToken(r.Context(), a, "SITE", r.PathValue("id"), raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 201, v)
}
func (h *HTTP) adminCreateDevice(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminCreateDevice(r.Context(), a, raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 201, v)
}
func (h *HTTP) adminListDevices(w http.ResponseWriter, r *http.Request, a AdminActor) {
	v, e := h.store.AdminListDevices(r.Context())
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminUpdateDevice(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminUpdateDevice(r.Context(), a, r.PathValue("id"), r.Header.Get("If-Match"), raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminIssueDeviceToken(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminIssueToken(r.Context(), a, "DEVICE", r.PathValue("id"), raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 201, v)
}
func (h *HTTP) adminCommand(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.EnqueueCommand(r.Context(), r.PathValue("id"), raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 202, map[string]any{"protocolVersion": "2.0", "requestId": v.RequestID, "applied": true})
}
func (h *HTTP) adminCommandGet(w http.ResponseWriter, r *http.Request, a AdminActor) {
	v, e := h.store.Command(r.Context(), r.PathValue("requestId"))
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminDeviceSettings(w http.ResponseWriter, r *http.Request, a AdminActor) {
	v, e := h.store.DeviceSettings(r.Context(), r.PathValue("id"))
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminDeviceModels(w http.ResponseWriter, r *http.Request, a AdminActor) {
	v, e := h.store.AdminModels(r.Context(), r.PathValue("id"))
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminCreateAccount(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminCreateAccount(r.Context(), a, raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 201, v)
}
func (h *HTTP) adminListAccounts(w http.ResponseWriter, r *http.Request, a AdminActor) {
	v, e := h.store.AdminListAccounts(r.Context(), a)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminUpdateAccount(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminUpdateAccount(r.Context(), a, r.PathValue("id"), r.Header.Get("If-Match"), raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminRevokeToken(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	if e := h.store.AdminRevokeToken(r.Context(), a, r.PathValue("id"), raw); e != nil {
		h.failure(w, e)
		return
	}
	var in struct {
		RequestID string `json:"requestId"`
	}
	_ = json.Unmarshal(raw, &in)
	h.reply(w, 200, map[string]any{"protocolVersion": "2.0", "requestId": in.RequestID, "applied": true})
}
func (h *HTTP) adminListTokens(w http.ResponseWriter, r *http.Request, a AdminActor) {
	v, e := h.store.AdminListTokens(r.Context(), a)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminModels(w http.ResponseWriter, r *http.Request, a AdminActor) {
	v, e := h.store.AdminModels(r.Context(), r.URL.Query().Get("deviceId"))
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminJobs(w http.ResponseWriter, r *http.Request, a AdminActor) {
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil {
			h.failure(w, problem(400, "INVALID_PAGE", "Invalid limit"))
			return
		}
		limit = n
	}
	var after int64
	if v := r.URL.Query().Get("cursor"); v != "" {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil {
			h.failure(w, problem(400, "INVALID_PAGE", "Invalid cursor"))
			return
		}
		after = n
	}
	page, e := h.store.AdminJobs(r.Context(), r.URL.Query().Get("siteId"), after, limit)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, page)
}
func (h *HTTP) adminCancelJob(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.Control(r.Context(), r.PathValue("id"), r.PathValue("jobId"), "cancel", raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	status := 200
	if v.Status == "CANCELLING" {
		status = 202
	}
	h.reply(w, status, v)
}
func (h *HTTP) adminCancelAll(w http.ResponseWriter, r *http.Request, a AdminActor) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.store.AdminCancelAll(r.Context(), a, r.PathValue("id"), raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) adminAudit(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if e := requireOwner(a); e != nil {
		h.failure(w, e)
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, e := strconv.Atoi(v)
		if e == nil {
			limit = n
		}
	}
	v, e := h.store.AdminAudit(r.Context(), limit)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, map[string]any{"items": v})
}
