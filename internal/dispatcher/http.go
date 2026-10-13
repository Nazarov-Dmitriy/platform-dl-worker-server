package dispatcher

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const MaxMetadataBytes int64 = 8 << 20

type HTTP struct {
	store *Store
	mux   *http.ServeMux
}

func Handler(s *Store) http.Handler {
	h := &HTTP{s, http.NewServeMux()}
	h.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if e := s.health(r.Context()); e != nil {
			h.failure(w, e)
			return
		}
		h.reply(w, 200, map[string]string{"status": "ok"})
	})
	h.mux.HandleFunc("GET /api/v2/site/capabilities", h.site(h.capabilities))
	h.mux.HandleFunc("POST /api/v2/site/jobs", h.site(h.submit))
	h.mux.HandleFunc("GET /api/v2/site/jobs", h.site(h.list))
	h.mux.HandleFunc("GET /api/v2/site/jobs/{id}", h.site(h.get))
	h.mux.HandleFunc("POST /api/v2/site/jobs/{id}/cancel", h.site(h.control))
	h.mux.HandleFunc("POST /api/v2/site/jobs/{id}/release", h.site(h.control))
	h.mux.HandleFunc("/api/v2/site/", h.site(func(w http.ResponseWriter, r *http.Request, p Principal) {
		h.failure(w, problem(501, "STAGE_NOT_IMPLEMENTED", "Storage transfer and publication endpoints arrive at stage 4"))
	}))
	h.mux.HandleFunc("/api/v2/device/connect", func(w http.ResponseWriter, r *http.Request) {
		if _, e := s.Authenticate(r.Context(), bearer(r), "DEVICE"); e != nil {
			h.failure(w, e)
			return
		}
		h.failure(w, problem(501, "STAGE_NOT_IMPLEMENTED", "Device WSS transport arrives at stage 3"))
	})
	h.mux.HandleFunc("/api/v2/admin/", func(w http.ResponseWriter, r *http.Request) {
		h.failure(w, problem(501, "STAGE_NOT_IMPLEMENTED", "Use the server CLI; admin sessions/panel arrive at stage 6"))
	})
	h.mux.HandleFunc("GET /api/site/operations", h.site(func(w http.ResponseWriter, r *http.Request, p Principal) {
		h.failure(w, problem(403, "PROTOCOL_UPGRADE_REQUIRED", "Update the site client to protocol 2.0"))
	}))
	h.mux.HandleFunc("POST /api/site/jobs", h.site(func(w http.ResponseWriter, r *http.Request, p Principal) {
		raw, e := h.body(w, r)
		if e != nil {
			h.failure(w, e)
			return
		}
		var input struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &input) != nil || input.ID == "" {
			h.failure(w, problem(400, "INVALID_REQUEST", "Legacy request needs an ID"))
			return
		}
		h.reply(w, 200, map[string]any{"id": input.ID, "status": "REJECTED", "error": &APIError{Code: "PROTOCOL_UPGRADE_REQUIRED", Message: "Update the site client to protocol 2.0", Permanent: true}})
	}))
	return h
}
func (h *HTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	h.mux.ServeHTTP(w, r)
}
func bearer(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if len(auth) < 7 || !strings.EqualFold(auth[:7], "Bearer ") {
		return ""
	}
	token := auth[7:]
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return ""
	}
	return token
}

type principalKey struct{}

func (h *HTTP) site(next func(http.ResponseWriter, *http.Request, Principal)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, e := h.store.Authenticate(r.Context(), bearer(r), "SITE")
		if e != nil {
			h.failure(w, e)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), principalKey{}, p))
		next(w, r, p)
	}
}
func (h *HTTP) reply(w http.ResponseWriter, status int, v any) {
	raw, e := json.Marshal(v)
	if e != nil {
		h.failure(w, e)
		return
	}
	if int64(len(raw)) > MaxMetadataBytes {
		h.failure(w, problem(413, "RESPONSE_TOO_LARGE", "Reduce the requested page size"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(raw, '\n'))
}
func (h *HTTP) failure(w http.ResponseWriter, e error) {
	var api *APIError
	if !errors.As(e, &api) {
		api = &APIError{Status: 503, Code: "STORAGE_UNAVAILABLE", Message: "Dispatcher storage is temporarily unavailable", Permanent: false}
	}
	h.reply(w, api.Status, api)
}
func (h *HTTP) body(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return nil, problem(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json")
	}
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxMetadataBytes))
	if e != nil {
		var max *http.MaxBytesError
		if errors.As(e, &max) {
			return nil, problem(413, "REQUEST_TOO_LARGE", "Metadata limit exceeded")
		}
		return nil, problem(400, "INVALID_REQUEST", "Cannot read request body")
	}
	return raw, nil
}
func (h *HTTP) submit(w http.ResponseWriter, r *http.Request, p Principal) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, created, e := h.store.Submit(r.Context(), p.ID, raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	status := 200
	if created {
		status = 202
	}
	h.reply(w, status, v)
}
func (h *HTTP) get(w http.ResponseWriter, r *http.Request, p Principal) {
	v, e := h.store.Get(r.Context(), p.ID, r.PathValue("id"))
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) capabilities(w http.ResponseWriter, r *http.Request, p Principal) {
	v, e := h.store.Capabilities(r.Context(), p.ID)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}
func (h *HTTP) list(w http.ResponseWriter, r *http.Request, p Principal) {
	limit := 20
	var after int64
	var e error
	q := r.URL.Query()
	if q.Get("limit") != "" {
		limit, e = strconv.Atoi(q.Get("limit"))
		if e != nil {
			h.failure(w, problem(400, "INVALID_PAGE", "Invalid limit"))
			return
		}
	}
	if q.Get("cursor") != "" {
		raw, e := base64.RawURLEncoding.DecodeString(q.Get("cursor"))
		if e != nil {
			h.failure(w, problem(400, "INVALID_PAGE", "Invalid cursor"))
			return
		}
		fields := strings.SplitN(string(raw), ":", 2)
		if len(fields) != 2 || fields[0] != p.ID {
			h.failure(w, problem(400, "INVALID_PAGE", "Cursor belongs to another site"))
			return
		}
		after, e = strconv.ParseInt(fields[1], 10, 64)
		if e != nil || after < 0 {
			h.failure(w, problem(400, "INVALID_PAGE", "Invalid cursor"))
			return
		}
	}
	jobs, cursor, e := h.store.List(r.Context(), p.ID, after, limit)
	if e != nil {
		h.failure(w, e)
		return
	}
	var next *string
	if len(jobs) == limit {
		v := base64.RawURLEncoding.EncodeToString([]byte(p.ID + ":" + strconv.FormatInt(cursor, 10)))
		next = &v
	}
	h.reply(w, 200, map[string]any{"protocolVersion": "2.0", "jobs": jobs, "nextCursor": next})
}
func (h *HTTP) control(w http.ResponseWriter, r *http.Request, p Principal) {
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	kind := "cancel"
	if strings.HasSuffix(r.URL.Path, "/release") {
		kind = "release"
	}
	v, e := h.store.Control(r.Context(), p.ID, r.PathValue("id"), kind, raw)
	if e != nil {
		h.failure(w, e)
		return
	}
	status := 200
	if v.Status == "CANCELLING" || v.Status == "RELEASING" {
		status = 202
	}
	h.reply(w, status, v)
}
