package dispatcher

import (
	"bytes"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (h *HTTP) requireErrors(w http.ResponseWriter, a AdminActor) bool {
	if e := requireOwner(a); e != nil {
		h.failure(w, e)
		return false
	}
	if h.errors == nil {
		h.failure(w, problem(503, "DIAGNOSTICS_UNAVAILABLE", "Error journal is not available"))
		return false
	}
	return true
}

func (h *HTTP) auditDiag(r *http.Request, a AdminActor, kind, target string) {
	_ = h.store.transaction(r.Context(), func(tx *sql.Tx) error {
		return audit(tx, h.store.now().UnixMilli(), kind, a.ID, target)
	})
}

func parseDiagQuery(r *http.Request) (DiagnosticsQuery, error) {
	q := r.URL.Query()
	dq := DiagnosticsQuery{
		Area: q.Get("area"), SiteID: q.Get("siteId"), Source: q.Get("source"),
		Status: q.Get("status"), Code: q.Get("code"), Module: q.Get("module"),
		Release: q.Get("release"), Severity: q.Get("severity"), Q: q.Get("q"), Cursor: q.Get("cursor"),
		Limit: 25,
	}
	if dq.Area == "" {
		dq.Area = "sites"
	}
	if q.Get("limit") != "" {
		n, e := strconv.Atoi(q.Get("limit"))
		if e != nil || (n != 10 && n != 25 && n != 50) {
			return dq, problem(400, "INVALID_PAGE", "limit must be 10, 25 or 50")
		}
		dq.Limit = n
	}
	if v := q.Get("favorite"); v != "" {
		f := v == "true" || v == "1"
		dq.Favorite = &f
	}
	if v := q.Get("from"); v != "" {
		t, e := time.Parse(time.RFC3339, v)
		if e != nil {
			return dq, problem(400, "INVALID_PAGE", "from must be RFC3339")
		}
		dq.From = t.UTC()
	}
	if v := q.Get("to"); v != "" {
		t, e := time.Parse(time.RFC3339, v)
		if e != nil {
			return dq, problem(400, "INVALID_PAGE", "to must be RFC3339")
		}
		dq.To = t.UTC()
	}
	return dq, dq.validate()
}

func (h *HTTP) adminDiagnosticsGroups(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	q, e := parseDiagQuery(r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.errors.ListGroups(r.Context(), q)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}

func (h *HTTP) adminDiagnosticsGroup(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	q, e := parseDiagQuery(r)
	if e != nil {
		h.failure(w, e)
		return
	}
	v, e := h.errors.GroupCard(r.Context(), r.PathValue("id"), q)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.reply(w, 200, v)
}

func (h *HTTP) adminDiagnosticsFavorite(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	if e = h.store.validator.Check("DiagnosticsFavorite", raw); e != nil {
		h.failure(w, e)
		return
	}
	var in struct {
		Favorite         bool `json:"favorite"`
		ConfirmUnprotect bool `json:"confirmUnprotect"`
	}
	_ = json.Unmarshal(raw, &in)
	v, e := h.errors.SetFavorite(r.Context(), r.PathValue("id"), in.Favorite, a.Login, in.ConfirmUnprotect)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.auditDiag(r, a, "DIAGNOSTICS_FAVORITE", r.PathValue("id"))
	h.reply(w, 200, v)
}

func (h *HTTP) adminDiagnosticsGroupStatus(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	if e = h.store.validator.Check("DiagnosticsStatusChange", raw); e != nil {
		h.failure(w, e)
		return
	}
	var in struct {
		Status           string `json:"status"`
		ConfirmUnprotect bool   `json:"confirmUnprotect"`
	}
	_ = json.Unmarshal(raw, &in)
	v, e := h.errors.SetStatus(r.Context(), r.PathValue("id"), in.Status, a.Login, in.ConfirmUnprotect)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.auditDiag(r, a, "DIAGNOSTICS_STATUS", r.PathValue("id"))
	h.reply(w, 200, v)
}

func (h *HTTP) adminDiagnosticsNote(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	if e = h.store.validator.Check("DiagnosticsNoteCreate", raw); e != nil {
		h.failure(w, e)
		return
	}
	var in struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal(raw, &in)
	id := r.PathValue("id")
	if e = h.errors.AddNote(r.Context(), id, a.Login, in.Text); e != nil {
		h.failure(w, e)
		return
	}
	h.auditDiag(r, a, "DIAGNOSTICS_NOTE", id)
	h.reply(w, 201, map[string]any{"at": stamp(h.errors.Now()), "author": a.Login, "text": strings.TrimSpace(in.Text)})
}

func (h *HTTP) adminDiagnosticsPin(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	if e = h.store.validator.Check("DiagnosticsExamplePin", raw); e != nil {
		h.failure(w, e)
		return
	}
	var in struct {
		Seq int64 `json:"seq"`
	}
	_ = json.Unmarshal(raw, &in)
	if e = h.errors.PinExample(r.Context(), r.PathValue("id"), in.Seq, a.Login); e != nil {
		h.failure(w, e)
		return
	}
	h.auditDiag(r, a, "DIAGNOSTICS_EXAMPLE", r.PathValue("id"))
	h.reply(w, 200, ProtectResult{OK: true, RetentionDays: h.errors.config.RetentionDays})
}

func (h *HTTP) adminDiagnosticsUnpin(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	seq, e := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if e != nil {
		h.failure(w, problem(400, "INVALID_REQUEST", "Invalid example seq"))
		return
	}
	v, err := h.errors.UnpinExample(r.Context(), r.PathValue("id"), seq, a.Login)
	if err != nil {
		h.failure(w, err)
		return
	}
	h.auditDiag(r, a, "DIAGNOSTICS_EXAMPLE", r.PathValue("id"))
	h.reply(w, 200, v)
}

func (h *HTTP) adminDiagnosticsSettingsGet(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	h.reply(w, 200, h.errors.SettingsView())
}

func (h *HTTP) adminDiagnosticsSettingsSet(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	raw, e := h.body(w, r)
	if e != nil {
		h.failure(w, e)
		return
	}
	if e = h.store.validator.Check("DiagnosticsSettings", raw); e != nil {
		h.failure(w, e)
		return
	}
	var in struct {
		RetentionDays int `json:"retentionDays"`
	}
	_ = json.Unmarshal(raw, &in)
	v, e := h.errors.SetRetention(r.Context(), in.RetentionDays)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.auditDiag(r, a, "DIAGNOSTICS_SETTINGS", "")
	h.reply(w, 200, v)
}

func (h *HTTP) adminDiagnosticsPrune(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	n, e := h.errors.PruneCounted(r.Context())
	if e != nil {
		h.failure(w, e)
		return
	}
	st, _ := h.errors.Status(r.Context())
	h.auditDiag(r, a, "DIAGNOSTICS_PRUNE", "")
	h.reply(w, 200, map[string]any{"removed": n, "checkpoint": true, "diskWarning": st.DiskWarning})
}

func (h *HTTP) adminDiagnosticsBackup(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	path, e := h.errors.Snapshot(r.Context(), defaultBackupKeep)
	if e != nil {
		h.failure(w, e)
		return
	}
	h.auditDiag(r, a, "DIAGNOSTICS_BACKUP", path)
	h.reply(w, 200, map[string]any{"path": path})
}

func (h *HTTP) adminDiagnosticsExport(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if !h.requireErrors(w, a) {
		return
	}
	q, e := parseDiagQuery(r)
	if e != nil {
		h.failure(w, e)
		return
	}
	format := r.URL.Query().Get("format")
	if format != "csv" && format != "json" {
		h.failure(w, problem(400, "INVALID_PAGE", "format must be csv or json"))
		return
	}
	rows, truncated, e := h.errors.ExportEvents(r.Context(), q)
	if e != nil {
		h.failure(w, e)
		return
	}
	if truncated {
		h.failure(w, problem(413, "EXPORT_TOO_LARGE", "Narrow the period; export is limited to 5000 events"))
		return
	}
	if format == "json" {
		page, _ := h.errors.ListGroups(r.Context(), q)
		h.reply(w, 200, map[string]any{"generatedAt": stamp(h.errors.Now()), "area": q.Area, "events": rows, "page": page})
		return
	}
	var buf bytes.Buffer
	buf.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(&buf)
	if e = writeDiagnosticsCSV(cw, rows); e != nil {
		h.failure(w, e)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="errors.csv"`)
	w.WriteHeader(200)
	_, _ = w.Write(buf.Bytes())
}
