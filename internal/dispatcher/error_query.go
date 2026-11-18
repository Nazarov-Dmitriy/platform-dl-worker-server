package dispatcher

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const maxExportEvents = 5000

type DiagnosticsQuery struct {
	Area, SiteID, Source, Status, Code, Module, Release, Severity, Q, Cursor string
	Favorite                                                                 *bool
	From, To                                                                 time.Time
	Limit                                                                    int
}

func (q *DiagnosticsQuery) bounds(now time.Time) (fromMS, toMS int64) {
	fromMS, toMS = 0, now.UnixMilli()+1
	if !q.From.IsZero() {
		fromMS = q.From.UnixMilli()
	}
	if !q.To.IsZero() {
		toMS = q.To.UnixMilli()
	}
	return fromMS, toMS
}

func (q *DiagnosticsQuery) validate() error {
	if q.Area != "sites" && q.Area != "worker" {
		return problem(400, "INVALID_PAGE", "area must be sites or worker")
	}
	if q.Area == "worker" {
		q.SiteID = ""
		if q.Source == "front" || q.Source == "back" {
			q.Source = ""
		}
	}
	if q.Source != "" && !contains([]string{"front", "back", "worker"}, q.Source) {
		return problem(400, "INVALID_PAGE", "invalid source")
	}
	if q.Status != "" && !contains([]string{"NEW", "IN_PROGRESS", "RESOLVED", "IGNORED"}, q.Status) {
		return problem(400, "INVALID_PAGE", "invalid status")
	}
	if q.Severity != "" && !contains([]string{"fatal", "error", "warning", "info"}, q.Severity) {
		return problem(400, "INVALID_PAGE", "invalid severity")
	}
	if !q.From.IsZero() && !q.To.IsZero() && !q.To.After(q.From) {
		return problem(400, "INVALID_PAGE", "to must be after from")
	}
	if q.Limit <= 0 {
		q.Limit = 25
	}
	if q.Limit > 50 {
		return problem(400, "INVALID_PAGE", "limit must be at most 50")
	}
	if len(q.Q) > 100 {
		q.Q = q.Q[:100]
	}
	return nil
}

func decodeGroupCursor(raw string) (int64, string, error) {
	if raw == "" {
		return 0, "", nil
	}
	b, e := base64.RawURLEncoding.DecodeString(raw)
	if e != nil {
		return 0, "", problem(400, "INVALID_PAGE", "Invalid cursor")
	}
	parts := strings.SplitN(string(b), ":", 2)
	if len(parts) != 2 {
		return 0, "", problem(400, "INVALID_PAGE", "Invalid cursor")
	}
	ms, e := strconv.ParseInt(parts[0], 10, 64)
	if e != nil {
		return 0, "", problem(400, "INVALID_PAGE", "Invalid cursor")
	}
	return ms, parts[1], nil
}

func encodeGroupCursor(ms int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(ms, 10) + ":" + id))
}

func (s *ErrorStore) ListGroups(ctx context.Context, q DiagnosticsQuery) (map[string]any, error) {
	if e := q.validate(); e != nil {
		return nil, e
	}
	fromMS, toMS := q.bounds(s.now())
	cursorMS, cursorID, e := decodeGroupCursor(q.Cursor)
	if e != nil {
		return nil, e
	}
	where, args := s.groupFilters(q, fromMS, toMS)
	if cursorMS > 0 {
		where = append(where, "(period_last < ? OR (period_last = ? AND g.id < ?))")
		args = append(args, cursorMS, cursorMS, cursorID)
	}
	args = append(args, q.Limit+1)
	sqlText := `SELECT g.id, g.area, g.site_id, g.source, g.code, g.module, g.status, g.favorite,
		g.first_seen, g.last_seen, g.occurrences, period_count, period_last, title
		FROM (` + s.groupSelect(fromMS, toMS) + `) g WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY period_last DESC, g.id DESC LIMIT ?`
	rows, e := s.db.QueryContext(ctx, sqlText, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		item, _, _, e := scanGroupRow(rows)
		if e != nil {
			return nil, e
		}
		items = append(items, item)
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	var next any
	if len(items) > q.Limit {
		last := items[q.Limit-1]
		next = encodeGroupCursor(last["_ms"].(int64), last["id"].(string))
		items = items[:q.Limit]
	}
	for _, item := range items {
		delete(item, "_ms")
	}
	sum, e := s.summarize(ctx, q, fromMS, toMS)
	if e != nil {
		return nil, e
	}
	st, _ := s.Status(ctx)
	var fromStamp, toStamp any
	if !q.From.IsZero() {
		fromStamp = stamp(q.From)
	}
	if !q.To.IsZero() {
		toStamp = stamp(q.To)
	}
	return map[string]any{
		"area":        q.Area,
		"from":        fromStamp,
		"to":          toStamp,
		"summary":     sum,
		"items":       items,
		"limit":       q.Limit,
		"nextCursor":  next,
		"diskWarning": st.DiskWarning,
	}, nil
}

func (s *ErrorStore) groupSelect(fromMS, toMS int64) string {
	return `SELECT g.*, 
		(SELECT count(*) FROM error_events e WHERE e.group_id=g.id AND e.received_at>=` + strconv.FormatInt(fromMS, 10) + ` AND e.received_at<` + strconv.FormatInt(toMS, 10) + `) AS period_count,
		coalesce((SELECT max(e.received_at) FROM error_events e WHERE e.group_id=g.id AND e.received_at>=` + strconv.FormatInt(fromMS, 10) + ` AND e.received_at<` + strconv.FormatInt(toMS, 10) + `), g.last_seen) AS period_last,
		coalesce((SELECT e.message FROM error_events e WHERE e.group_id=g.id ORDER BY e.received_at DESC, e.seq DESC LIMIT 1), g.code) AS title
		FROM error_groups g`
}

func (s *ErrorStore) groupFilters(q DiagnosticsQuery, fromMS, toMS int64) ([]string, []any) {
	where := []string{"g.area=?", "period_count>0"}
	args := []any{q.Area}
	if q.SiteID != "" {
		where = append(where, "g.site_id=?")
		args = append(args, q.SiteID)
	}
	if q.Source != "" {
		where = append(where, "g.source=?")
		args = append(args, q.Source)
	}
	if q.Status != "" {
		where = append(where, "g.status=?")
		args = append(args, q.Status)
	}
	if q.Favorite != nil {
		v := 0
		if *q.Favorite {
			v = 1
		}
		where = append(where, "g.favorite=?")
		args = append(args, v)
	}
	if q.Code != "" {
		where = append(where, "g.code=?")
		args = append(args, q.Code)
	}
	if q.Module != "" {
		where = append(where, "g.module=?")
		args = append(args, q.Module)
	}
	if q.Release != "" {
		where = append(where, `EXISTS (SELECT 1 FROM error_events e WHERE e.group_id=g.id AND e.release=? AND e.received_at>=? AND e.received_at<?)`)
		args = append(args, q.Release, fromMS, toMS)
	}
	if q.Severity != "" {
		where = append(where, `EXISTS (SELECT 1 FROM error_events e WHERE e.group_id=g.id AND e.severity=? AND e.received_at>=? AND e.received_at<?)`)
		args = append(args, q.Severity, fromMS, toMS)
	}
	if q.Q != "" {
		like := "%" + escapeLike(q.Q) + "%"
		where = append(where, "(g.code LIKE ? ESCAPE '\\' OR g.module LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')")
		args = append(args, like, like, like)
	}
	return where, args
}

func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

func scanGroupRow(rows *sql.Rows) (map[string]any, int64, string, error) {
	var id, area, siteID, source, code, module, status, title string
	var favorite, periodCount, lifetime int
	var first, last, periodLast int64
	if e := rows.Scan(&id, &area, &siteID, &source, &code, &module, &status, &favorite, &first, &last, &lifetime, &periodCount, &periodLast, &title); e != nil {
		return nil, 0, "", e
	}
	title = clip(strings.TrimSpace(title), 240)
	if title == "" {
		title = code
		if title == "" {
			title = "Ошибка"
		}
	}
	item := map[string]any{
		"id": id, "title": title, "area": area, "siteId": siteID, "source": source,
		"code": code, "module": module, "status": status, "favorite": favorite == 1,
		"periodCount": periodCount, "lifetimeCount": lifetime,
		"firstSeenAt": stamp(time.UnixMilli(first)), "lastSeenAt": stamp(time.UnixMilli(periodLast)),
		"protected": favorite == 1 || status == "IN_PROGRESS",
		"_ms":       periodLast,
	}
	return item, periodLast, id, nil
}

func (s *ErrorStore) summarize(ctx context.Context, q DiagnosticsQuery, fromMS, toMS int64) (map[string]any, error) {
	where, args := s.groupFilters(q, fromMS, toMS)
	sqlText := `SELECT coalesce(sum(period_count),0), count(*),
		coalesce(sum(CASE WHEN first_seen>=? AND first_seen<? THEN 1 ELSE 0 END),0)
		FROM (` + s.groupSelect(fromMS, toMS) + `) g WHERE ` + strings.Join(where, " AND ")
	sumArgs := append([]any{fromMS, toMS}, args...)
	var cases, groups, neu int
	if e := s.db.QueryRowContext(ctx, sqlText, sumArgs...).Scan(&cases, &groups, &neu); e != nil {
		return nil, e
	}
	return map[string]any{"cases": cases, "groups": groups, "newGroups": neu}, nil
}

func (s *ErrorStore) GroupCard(ctx context.Context, id string, q DiagnosticsQuery) (map[string]any, error) {
	_ = q.validate()
	fromMS, toMS := q.bounds(s.now())
	row := s.db.QueryRowContext(ctx, `SELECT g.id, g.area, g.site_id, g.source, g.code, g.module, g.status, g.favorite,
		g.first_seen, g.last_seen, g.occurrences, period_count, period_last, title, g.pinned_examples
		FROM (`+s.groupSelect(fromMS, toMS)+`) g WHERE g.id=?`, id)
	var area, siteID, source, code, module, status, title string
	var favorite, periodCount, lifetime, pinned int
	var first, last, periodLast int64
	var gid string
	e := row.Scan(&gid, &area, &siteID, &source, &code, &module, &status, &favorite, &first, &last, &lifetime, &periodCount, &periodLast, &title, &pinned)
	if errorsIsNoRows(e) {
		return nil, problem(404, "NOT_FOUND", "Error group not found")
	}
	if e != nil {
		return nil, e
	}
	if q.Area != "" && area != q.Area {
		return nil, problem(404, "NOT_FOUND", "Error group not found")
	}
	title = clip(strings.TrimSpace(title), 240)
	if title == "" {
		title = code
	}
	latest, e := s.loadLatestEvent(ctx, id)
	if e != nil {
		return nil, e
	}
	examples, e := s.loadEvents(ctx, `SELECT `+eventColumns+` FROM error_events ev
		JOIN error_examples x ON x.event_seq=ev.seq WHERE x.group_id=? ORDER BY x.saved_at`, []any{id}, true)
	if e != nil {
		return nil, e
	}
	repeats, e := s.loadEvents(ctx, `SELECT `+eventColumns+` FROM error_events ev WHERE ev.group_id=?
		AND ev.received_at>=? AND ev.received_at<? ORDER BY ev.received_at DESC, ev.seq DESC LIMIT 20`, []any{id, fromMS, toMS}, false)
	if e != nil {
		return nil, e
	}
	related, e := s.relatedEvents(ctx, latest)
	if e != nil {
		return nil, e
	}
	notes, e := s.loadNotes(ctx, id)
	if e != nil {
		return nil, e
	}
	history, e := s.loadHistory(ctx, id)
	if e != nil {
		return nil, e
	}
	card := map[string]any{
		"id": gid, "title": title, "area": area, "siteId": siteID, "source": source,
		"code": code, "module": module, "status": status, "favorite": favorite == 1,
		"periodCount": periodCount, "lifetimeCount": lifetime,
		"firstSeenAt": stamp(time.UnixMilli(first)), "lastSeenAt": stamp(time.UnixMilli(periodLast)),
		"protected": favorite == 1 || status == "IN_PROGRESS", "protectedExamples": pinned,
		"latest": latest, "examples": examples, "repeats": repeats, "related": related,
		"notes": notes, "history": history,
	}
	card["report"] = formatGroupReport(card)
	return card, nil
}

const eventColumns = `ev.seq, ev.event_id, ev.occurred_at, ev.received_at, ev.source, ev.service, ev.environment, ev.release,
	ev.severity, ev.code, ev.module, ev.operation, ev.stage, ev.message, ev.cause, ev.stack, ev.context, ev.breadcrumbs,
	ev.request_id, ev.operation_id, ev.resource_id, ev.job_id, ev.device_id,
	EXISTS(SELECT 1 FROM error_examples x WHERE x.event_seq=ev.seq)`

func (s *ErrorStore) loadLatestEvent(ctx context.Context, groupID string) (map[string]any, error) {
	items, e := s.loadEvents(ctx, `SELECT `+eventColumns+` FROM error_events ev WHERE ev.group_id=?
		ORDER BY ev.received_at DESC, ev.seq DESC LIMIT 1`, []any{groupID}, false)
	if e != nil {
		return nil, e
	}
	if len(items) == 0 {
		return nil, problem(404, "NOT_FOUND", "Error group not found")
	}
	return items[0], nil
}

func (s *ErrorStore) loadEvents(ctx context.Context, q string, args []any, forcePinned bool) ([]map[string]any, error) {
	rows, e := s.db.QueryContext(ctx, q, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		item, e := scanStoredEvent(rows)
		if e != nil {
			return nil, e
		}
		if forcePinned {
			item["pinned"] = true
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func scanStoredEvent(rows interface {
	Scan(dest ...any) error
}) (map[string]any, error) {
	var seq int64
	var eventID, source, service, env, release, severity, code, module, operation, stage, message, cause, stack, context, crumbs, req, op, res, job, device string
	var occurred, received int64
	var pinned int
	if e := rows.Scan(&seq, &eventID, &occurred, &received, &source, &service, &env, &release, &severity, &code, &module, &operation, &stage,
		&message, &cause, &stack, &context, &crumbs, &req, &op, &res, &job, &device, &pinned); e != nil {
		return nil, e
	}
	var breadcrumbs []DiagnosticsBreadcrumb
	if crumbs != "" && crumbs != "null" {
		_ = json.Unmarshal([]byte(crumbs), &breadcrumbs)
	}
	if breadcrumbs == nil {
		breadcrumbs = []DiagnosticsBreadcrumb{}
	}
	return map[string]any{
		"seq": seq, "eventId": eventID, "occurredAt": stamp(time.UnixMilli(occurred)), "receivedAt": stamp(time.UnixMilli(received)),
		"source": source, "service": service, "environment": env, "release": release, "severity": severity,
		"code": code, "module": module, "operation": operation, "stage": stage, "message": message, "cause": cause,
		"stack": stack, "context": context, "breadcrumbs": breadcrumbs, "requestId": req, "operationId": op,
		"resourceId": res, "jobId": job, "deviceId": device, "pinned": pinned == 1,
	}, nil
}

func (s *ErrorStore) relatedEvents(ctx context.Context, latest map[string]any) ([]map[string]any, error) {
	req, _ := latest["requestId"].(string)
	op, _ := latest["operationId"].(string)
	if req == "" && op == "" {
		return []map[string]any{}, nil
	}
	where := []string{"ev.seq!=?"}
	args := []any{latest["seq"]}
	parts := []string{}
	if req != "" {
		parts = append(parts, "ev.request_id=?")
		args = append(args, req)
	}
	if op != "" {
		parts = append(parts, "ev.operation_id=?")
		args = append(args, op)
	}
	where = append(where, "("+strings.Join(parts, " OR ")+")")
	return s.loadEvents(ctx, `SELECT `+eventColumns+` FROM error_events ev WHERE `+strings.Join(where, " AND ")+` ORDER BY ev.received_at DESC LIMIT 20`, args, false)
}

func (s *ErrorStore) loadNotes(ctx context.Context, groupID string) ([]map[string]any, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT at,author,text FROM error_notes WHERE group_id=? ORDER BY seq", groupID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var at int64
		var author, text string
		if e = rows.Scan(&at, &author, &text); e != nil {
			return nil, e
		}
		items = append(items, map[string]any{"at": stamp(time.UnixMilli(at)), "author": author, "text": text})
	}
	return items, rows.Err()
}

func (s *ErrorStore) loadHistory(ctx context.Context, groupID string) ([]map[string]any, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT at,author,change FROM error_history WHERE group_id=? ORDER BY seq", groupID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var at int64
		var author, change string
		if e = rows.Scan(&at, &author, &change); e != nil {
			return nil, e
		}
		items = append(items, map[string]any{"at": stamp(time.UnixMilli(at)), "author": author, "change": change})
	}
	return items, rows.Err()
}

func errorsIsNoRows(e error) bool {
	return errors.Is(e, sql.ErrNoRows)
}

func formatGroupReport(card map[string]any) string {
	latest, _ := card["latest"].(map[string]any)
	var b strings.Builder
	fmt.Fprintf(&b, "Ошибка: %s\nКод: %s\nОбласть: %s\nИсточник: %s\nСтатус: %s\nИзбранное: %v\n",
		card["title"], card["code"], card["area"], card["source"], card["status"], card["favorite"])
	if latest != nil {
		fmt.Fprintf(&b, "Сообщение: %s\nПричина: %s\nМодуль: %s\nСтадия: %s\nSeverity: %s\nEnvironment: %s\nRelease: %s\n",
			latest["message"], latest["cause"], latest["module"], latest["stage"], latest["severity"], latest["environment"], latest["release"])
		fmt.Fprintf(&b, "occurredAt: %s\nreceivedAt: %s\neventId: %s\nrequestId: %s\noperationId: %s\njobId: %s\n",
			latest["occurredAt"], latest["receivedAt"], latest["eventId"], latest["requestId"], latest["operationId"], latest["jobId"])
		stack, _ := latest["stack"].(string)
		if stack == "" {
			b.WriteString("Стек: отсутствует\n")
		} else {
			b.WriteString("Стек:\n" + stack + "\n")
		}
		fmt.Fprintf(&b, "Контекст: %s\n", latest["context"])
	}
	fmt.Fprintf(&b, "Случаев за период: %v, всего: %v\n", card["periodCount"], card["lifetimeCount"])
	if notes, ok := card["notes"].([]map[string]any); ok && len(notes) > 0 {
		b.WriteString("Заметки:\n")
		for _, n := range notes {
			fmt.Fprintf(&b, "- %s %s: %s\n", n["at"], n["author"], n["text"])
		}
	}
	if hist, ok := card["history"].([]map[string]any); ok && len(hist) > 0 {
		b.WriteString("История:\n")
		for _, n := range hist {
			fmt.Fprintf(&b, "- %s %s\n", n["at"], n["change"])
		}
	}
	return b.String()
}

func (s *ErrorStore) ExportEvents(ctx context.Context, q DiagnosticsQuery) ([]map[string]any, bool, error) {
	if e := q.validate(); e != nil {
		return nil, false, e
	}
	fromMS, toMS := q.bounds(s.now())
	where, args := s.groupFilters(q, fromMS, toMS)
	sqlText := `SELECT ev.seq, ev.event_id, ev.occurred_at, ev.received_at, ev.source, ev.service, ev.environment, ev.release,
		ev.severity, ev.code, ev.module, ev.operation, ev.stage, ev.message, ev.cause, ev.stack, ev.context, ev.breadcrumbs,
		ev.request_id, ev.operation_id, ev.resource_id, ev.job_id, ev.device_id,
		EXISTS(SELECT 1 FROM error_examples x WHERE x.event_seq=ev.seq),
		g.id, g.area, g.site_id, g.status, g.occurrences
		FROM error_events ev JOIN error_groups g ON g.id=ev.group_id
		WHERE ev.group_id IN (SELECT g.id FROM (` + s.groupSelect(fromMS, toMS) + `) g WHERE ` + strings.Join(where, " AND ") + `)
		AND ev.received_at>=? AND ev.received_at<?
		ORDER BY ev.received_at DESC, ev.seq DESC LIMIT ?`
	queryArgs := append(append([]any{}, args...), fromMS, toMS, maxExportEvents+1)
	rows, e := s.db.QueryContext(ctx, sqlText, queryArgs...)
	if e != nil {
		return nil, false, e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		item, e := scanExportRow(rows)
		if e != nil {
			return nil, false, e
		}
		items = append(items, item)
	}
	if e = rows.Err(); e != nil {
		return nil, false, e
	}
	truncated := len(items) > maxExportEvents
	if truncated {
		items = items[:maxExportEvents]
	}
	return items, truncated, nil
}

func scanExportRow(rows *sql.Rows) (map[string]any, error) {
	var seq int64
	var eventID, source, service, env, release, severity, code, module, operation, stage, message, cause, stack, contextJSON, crumbs, req, op, res, job, device string
	var occurred, received int64
	var pinned int
	var groupID, area, siteID, status string
	var occ int
	if e := rows.Scan(&seq, &eventID, &occurred, &received, &source, &service, &env, &release, &severity, &code, &module, &operation, &stage,
		&message, &cause, &stack, &contextJSON, &crumbs, &req, &op, &res, &job, &device, &pinned, &groupID, &area, &siteID, &status, &occ); e != nil {
		return nil, e
	}
	return map[string]any{
		"area": area, "siteId": siteID, "source": source, "message": message, "cause": cause, "code": code, "module": module,
		"status": status, "groupId": groupID, "groupCount": occ, "eventId": eventID,
		"occurredAt": stamp(time.UnixMilli(occurred)), "receivedAt": stamp(time.UnixMilli(received)),
		"release": release, "environment": env, "requestId": req, "operationId": op, "resourceId": res,
		"jobId": job, "deviceId": device, "stack": stack, "context": contextJSON, "breadcrumbs": crumbs, "history": "",
		"pinned": pinned == 1,
	}, nil
}

func csvProtect(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@':
		return "'" + s
	}
	return s
}

func writeDiagnosticsCSV(w *csv.Writer, rows []map[string]any) error {
	w.Comma = ';'
	header := []string{"area", "siteId", "source", "message", "cause", "code", "module", "status",
		"groupId", "groupCount", "eventId", "occurredAt", "receivedAt", "release", "environment",
		"requestId", "operationId", "resourceId", "jobId", "deviceId", "stack", "context", "breadcrumbs", "history"}
	if e := w.Write(header); e != nil {
		return e
	}
	for _, row := range rows {
		rec := make([]string, len(header))
		for i, key := range header {
			rec[i] = csvProtect(fmt.Sprint(row[key]))
		}
		if e := w.Write(rec); e != nil {
			return e
		}
	}
	w.Flush()
	return w.Error()
}
