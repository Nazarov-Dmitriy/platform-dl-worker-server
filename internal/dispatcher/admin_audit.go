package dispatcher

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

type AuditFilter struct {
	Limit                int
	Cursor               int64
	Kind, Principal, Job string
	From, To             time.Time
	ErrorsOnly           bool
}

type AuditPage struct {
	Items      []map[string]any `json:"items"`
	NextCursor *int64           `json:"nextCursor"`
}

func (s *Store) AuditPage(ctx context.Context, f AuditFilter) (AuditPage, error) {
	page := AuditPage{Items: []map[string]any{}}
	if f.Limit < 1 || f.Limit > 100 || f.Cursor < 0 || len(f.Kind) > 64 || len(f.Principal) > 128 || len(f.Job) > 128 || (!f.From.IsZero() && !f.To.IsZero() && f.To.Before(f.From)) {
		return page, problem(400, "INVALID_PAGE", "Invalid audit filters")
	}
	where := []string{"1=1"}
	args := []any{}
	if f.Cursor > 0 {
		where = append(where, "a.seq < ?")
		args = append(args, f.Cursor)
	}
	for _, v := range []struct{ column, value string }{{"a.kind", f.Kind}, {"a.principal_id", f.Principal}, {"a.job_id", f.Job}} {
		if v.value != "" {
			where = append(where, v.column+" = ?")
			args = append(args, v.value)
		}
	}
	if f.ErrorsOnly {
		where = append(where, "(a.kind LIKE '%FAILED%' OR a.kind LIKE '%ERROR%' OR a.kind LIKE '%REJECTED%')")
	}
	if !f.From.IsZero() {
		where = append(where, "a.at >= ?")
		args = append(args, f.From.UnixMilli())
	}
	if !f.To.IsZero() {
		where = append(where, "a.at <= ?")
		args = append(args, f.To.UnixMilli())
	}
	args = append(args, f.Limit+1)
	rows, e := s.db.QueryContext(ctx, `SELECT a.seq,a.at,a.kind,a.principal_id,a.job_id,COALESCE(d.name,st.name,ac.login,''),j.view
 FROM audit a LEFT JOIN devices d ON d.id=a.principal_id LEFT JOIN sites st ON st.id=a.principal_id LEFT JOIN accounts ac ON ac.id=a.principal_id
 LEFT JOIN jobs j ON j.seq=(SELECT seq FROM jobs WHERE id=a.job_id ORDER BY seq DESC LIMIT 1)
 WHERE `+strings.Join(where, " AND ")+" ORDER BY a.seq DESC LIMIT ?", args...)
	if e != nil {
		return page, e
	}
	defer rows.Close()
	var seqs []int64
	for rows.Next() {
		var seq, at int64
		var kind, principal, job, name string
		var raw []byte
		if e = rows.Scan(&seq, &at, &kind, &principal, &job, &name, &raw); e != nil {
			return page, e
		}
		item := map[string]any{"at": stamp(time.UnixMilli(at)), "kind": kind, "principalId": principal, "principalName": name, "jobId": job}
		if strings.Contains(kind, "FAILED") || strings.Contains(kind, "ERROR") || strings.Contains(kind, "REJECTED") {
			var view struct {
				Error  *APIError `json:"error"`
				Status string    `json:"status"`
				Stage  string    `json:"stage"`
			}
			if len(raw) > 0 && json.Unmarshal(raw, &view) == nil {
				item["error"] = view.Error
				item["jobStatus"] = view.Status
				item["stage"] = view.Stage
			}
		}
		page.Items = append(page.Items, item)
		seqs = append(seqs, seq)
	}
	if e = rows.Err(); e != nil {
		return page, e
	}
	if len(page.Items) > f.Limit {
		page.Items = page.Items[:f.Limit]
		next := seqs[f.Limit-1]
		page.NextCursor = &next
	}
	return page, nil
}

func (s *Store) RecentAdminJobs(ctx context.Context, site string, limit int) (map[string]any, error) {
	if site == "" || limit < 1 || limit > 100 {
		return nil, problem(400, "INVALID_PAGE", "Invalid jobs page")
	}
	rows, e := s.db.QueryContext(ctx, "SELECT view FROM jobs WHERE site_id=? ORDER BY seq DESC LIMIT ?", site, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	jobs := []JobView{}
	for rows.Next() {
		var raw []byte
		var view JobView
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		if e = json.Unmarshal(raw, &view); e != nil {
			return nil, e
		}
		jobs = append(jobs, view)
	}
	return map[string]any{"protocolVersion": "2.0", "jobs": jobs, "nextCursor": nil}, rows.Err()
}
