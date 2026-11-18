package dispatcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// DiagnosticsBatch is the site ingress payload: a single atomic delivery of
// 1..50 diagnostic events. The site is derived from the site token, never from
// the request body.
type DiagnosticsBatch struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Events          []DiagnosticsEvent `json:"events"`
}

// ConfigureErrors wires the diagnostics journal into the HTTP handler. The
// endpoint stays unavailable (503) until the store is attached.
func (h *HTTP) ConfigureErrors(s *ErrorStore) { h.errors = s }

// RequireSiteDiagnostics enforces that the site is enabled and has the
// «Сбор ошибок» permission. Turning collection off does not revoke the site
// token or its other actions; it only rejects this ingress.
func (s *Store) RequireSiteDiagnostics(ctx context.Context, site string) error {
	var enabled bool
	var ops string
	e := s.db.QueryRowContext(ctx, "SELECT enabled,operations FROM sites WHERE id=? AND deleted=0", site).Scan(&enabled, &ops)
	if errors.Is(e, sql.ErrNoRows) {
		return problem(403, "FORBIDDEN", "Unknown site")
	}
	if e != nil {
		return e
	}
	if !enabled {
		return problem(403, "SITE_DISABLED", "Diagnostics collection is disabled for this site")
	}
	var allowed []string
	if e = json.Unmarshal([]byte(ops), &allowed); e != nil {
		return e
	}
	if !contains(allowed, "diagnostics.collect") {
		return problem(403, "OPERATION_FORBIDDEN", "Error collection is not permitted for this site")
	}
	return nil
}

// diagnosticsEvents receives front/back events through the authenticated site
// channel and ACKs only after the batch is committed.
func (h *HTTP) diagnosticsEvents(w http.ResponseWriter, r *http.Request, p Principal) {
	if h.errors == nil {
		h.failure(w, problem(503, "DIAGNOSTICS_UNAVAILABLE", "Error journal is not available"))
		return
	}
	if e := h.store.RequireSiteDiagnostics(r.Context(), p.ID); e != nil {
		h.failure(w, e)
		return
	}
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	if len(raw) > maxBatchBytes {
		h.failure(w, problem(413, "BATCH_TOO_LARGE", "Diagnostics batch exceeds 256 KiB"))
		return
	}
	if e = h.store.validator.Check("DiagnosticsBatch", raw); e != nil {
		h.failure(w, e)
		return
	}
	var batch DiagnosticsBatch
	if e = json.Unmarshal(raw, &batch); e != nil {
		h.failure(w, problem(400, "INVALID_BATCH", "Invalid diagnostics batch"))
		return
	}
	for _, ev := range batch.Events {
		if ev.Source == "worker" {
			h.failure(w, problem(403, "OPERATION_FORBIDDEN", "Site ingress only accepts front/back sources"))
			return
		}
	}
	sender := DiagnosticsSender{ID: p.ID, Area: "sites", SiteID: p.ID}
	accepted, duplicates, e := h.errors.Record(r.Context(), sender, batch.Events)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, map[string]any{
		"protocolVersion": "2.0",
		"accepted":        accepted,
		"duplicates":      duplicates,
		"receivedAt":      stamp(h.errors.Now()),
	})
}
