package dispatcher

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gofrs/flock"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Config struct {
	OfferTTL          time.Duration
	LeaseTTL          time.Duration
	OnlineTTL         time.Duration
	AdmissionStable   time.Duration
	QueueDelay        time.Duration
	HistoryDays       int
	AuditDays         int
	CPUThreshold      float64
	MemoryThreshold   float64
	DiskThreshold     float64
	MinimumFreeMemory int64
	ExecutorAttempts  int
}

func DefaultConfig() Config {
	return Config{10 * time.Second, 120 * time.Second, 45 * time.Second, 15 * time.Second, 600 * time.Second, 30, 30, 80, 80, 80, 64 << 20, 3}
}
func (c Config) validate() error {
	if c.OfferTTL <= 0 || c.LeaseTTL < 10*time.Second || c.OnlineTTL <= 0 || c.AdmissionStable < 0 || c.QueueDelay <= 0 || c.HistoryDays < 1 || c.AuditDays < 1 || c.ExecutorAttempts < 1 || c.CPUThreshold <= 0 || c.CPUThreshold > 100 || c.MemoryThreshold <= 0 || c.MemoryThreshold > 100 || c.DiskThreshold <= 0 || c.DiskThreshold > 100 || c.MinimumFreeMemory < 0 {
		return errors.New("invalid dispatcher configuration")
	}
	return nil
}

type Store struct {
	db        *sql.DB
	lock      *flock.Flock
	config    Config
	validator *Validator
	now       func() time.Time
	epoch     string
}

func Open(path string, config Config) (*Store, error) {
	if e := config.validate(); e != nil {
		return nil, e
	}
	path, e := filepath.Abs(path)
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	lock := flock.New(path + ".lock")
	ok, e := lock.TryLock()
	if e != nil {
		return nil, e
	}
	if !ok {
		return nil, errors.New("another dispatcher owns this database")
	}
	uriPath := filepath.ToSlash(path)
	if filepath.VolumeName(path) != "" {
		uriPath = "/" + uriPath
	}
	u := url.URL{Scheme: "file", Path: uriPath}
	q := u.Query()
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(FULL)")
	q.Set("_txlock", "immediate")
	u.RawQuery = q.Encode()
	db, e := sql.Open("sqlite", u.String())
	if e != nil {
		_ = lock.Unlock()
		return nil, e
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := &Store{db: db, lock: lock, config: config, now: time.Now}
	fail := func(e error) (*Store, error) { _ = s.Close(); return nil, e }
	if e = db.Ping(); e != nil {
		return fail(e)
	}
	var exists int
	if e = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'").Scan(&exists); e != nil {
		return fail(e)
	}
	if exists == 0 {
		raw, e := migrations.ReadFile("migrations/001_core.sql")
		if e != nil {
			return fail(e)
		}
		tx, e := db.Begin()
		if e != nil {
			return fail(e)
		}
		if _, e = tx.Exec(string(raw)); e != nil {
			_ = tx.Rollback()
			return fail(e)
		}
		if e = tx.Commit(); e != nil {
			return fail(e)
		}
	} else {
		var version int
		if e = db.QueryRow("SELECT max(version) FROM schema_migrations").Scan(&version); e != nil {
			return fail(e)
		}
		if version != 1 {
			return fail(errors.New("unsupported database schema version"))
		}
	}
	if _, e = db.Exec("INSERT OR IGNORE INTO metadata(key,value) VALUES('epoch',?)", UUID()); e != nil {
		return fail(e)
	}
	if e = db.QueryRow("SELECT value FROM metadata WHERE key='epoch'").Scan(&s.epoch); e != nil {
		return fail(e)
	}
	// Process-local sessions cannot survive restart; execution leases do survive.
	if _, e = db.Exec("UPDATE devices SET session_id='',session_token='',last_seen=0,ready_since=0"); e != nil {
		return fail(e)
	}
	if s.validator, e = NewValidator(); e != nil {
		return fail(e)
	}
	return s, nil
}
func (s *Store) Close() error {
	e := s.db.Close()
	if u := s.lock.Unlock(); e == nil {
		e = u
	}
	return e
}
func (s *Store) Epoch() string { return s.epoch }
func (s *Store) transaction(ctx context.Context, run func(*sql.Tx) error) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if p, ok := ctx.Value(principalKey{}).(Principal); ok {
		var n int
		if e = tx.QueryRow("SELECT count(*) FROM tokens WHERE id=? AND principal_id=? AND purpose='SITE' AND revoked=0", p.TokenID, p.ID).Scan(&n); e != nil {
			return e
		}
		if n == 0 || p.Purpose != "SITE" {
			return problem(401, "UNAUTHORIZED", "Token revoked")
		}
	}
	if e = run(tx); e != nil {
		return e
	}
	return tx.Commit()
}
func audit(tx *sql.Tx, at int64, kind, principal, job string) error {
	_, e := tx.Exec("INSERT INTO audit(at,kind,principal_id,job_id) VALUES(?,?,?,?)", at, kind, principal, job)
	return e
}
func (s *Store) CreateSite(ctx context.Context, name string, weight int, ops []string) (Site, error) {
	v := Site{UUID(), name, true, weight, ops, 1}
	if strings.TrimSpace(name) == "" || weight < 1 || weight > 100 || len(ops) == 0 {
		return v, problem(400, "INVALID_SITE", "Invalid site settings")
	}
	seen := map[string]bool{}
	for _, op := range ops {
		if seen[op] || !contains([]string{"media.transcode", "media.transcribe", "media.subtitles"}, op) {
			return v, problem(400, "INVALID_SITE", "Unknown or duplicate operation")
		}
		seen[op] = true
	}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		if _, e := tx.Exec("INSERT INTO sites(id,name,enabled,weight,operations) VALUES(?,?,1,?,?)", v.ID, name, weight, string(encode(ops))); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "SITE_CREATED", v.ID, "")
	})
	return v, e
}
func (s *Store) SetSite(ctx context.Context, id string, enabled bool, weight int, operations ...[]string) error {
	if weight < 1 || weight > 100 {
		return problem(400, "INVALID_SITE", "Invalid priority")
	}
	if len(operations) > 1 {
		return problem(400, "INVALID_SITE", "Only one operation list is allowed")
	}
	if len(operations) == 1 {
		seen := map[string]bool{}
		for _, op := range operations[0] {
			if seen[op] || !contains([]string{"media.transcode", "media.transcribe", "media.subtitles"}, op) {
				return problem(400, "INVALID_SITE", "Unknown or duplicate operation")
			}
			seen[op] = true
		}
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.Exec("UPDATE sites SET enabled=?,weight=?,revision=revision+1 WHERE id=?", enabled, weight, id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return problem(404, "NOT_FOUND", "Site not found")
		}
		if len(operations) == 1 {
			if _, e = tx.Exec("UPDATE sites SET operations=? WHERE id=?", string(encode(operations[0])), id); e != nil {
				return e
			}
		}
		if _, e = tx.Exec("DELETE FROM scheduler_credits"); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "SITE_UPDATED", id, "")
	})
}
func (s *Store) CreateDevice(ctx context.Context, name string, caps []Capability) (Device, error) {
	v := Device{UUID(), name, true, 1}
	if strings.TrimSpace(name) == "" {
		return v, problem(400, "INVALID_DEVICE", "Device name required")
	}
	if e := s.checkCaps(caps); e != nil {
		return v, e
	}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec("INSERT INTO devices(id,name,enabled,capabilities) VALUES(?,?,1,?)", v.ID, name, string(encode(caps)))
		if e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "DEVICE_CREATED", v.ID, "")
	})
	return v, e
}
func (s *Store) SetDevice(ctx context.Context, id string, enabled bool) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.Exec("UPDATE devices SET enabled=?,revision=revision+1,session_id='',session_token='',ready_since=0 WHERE id=?", enabled, id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return problem(404, "NOT_FOUND", "Device not found")
		}
		return audit(tx, s.now().UnixMilli(), "DEVICE_UPDATED", id, "")
	})
}
func (s *Store) checkCaps(caps []Capability) error {
	if len(caps) > 3 {
		return problem(400, "INVALID_CAPABILITIES", "Too many operations")
	}
	seen := map[string]bool{}
	for _, c := range caps {
		if seen[c.Code] {
			return problem(400, "INVALID_CAPABILITIES", "Duplicate operation")
		}
		seen[c.Code] = true
		if e := s.validator.Check("OperationCapability", encode(c)); e != nil {
			return e
		}
	}
	return nil
}
func (s *Store) IssueToken(ctx context.Context, purpose, id string) (TokenView, string, error) {
	var raw [32]byte
	if _, e := rand.Read(raw[:]); e != nil {
		return TokenView{}, "", e
	}
	secret := base64.RawURLEncoding.EncodeToString(raw[:])
	v := TokenView{UUID(), purpose, id, stamp(s.now()), false}
	table := map[string]string{"SITE": "sites", "DEVICE": "devices"}[purpose]
	if table == "" {
		return v, "", problem(400, "INVALID_TOKEN_PURPOSE", "Unknown token purpose")
	}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var n int
		if e := tx.QueryRow("SELECT count(*) FROM "+table+" WHERE id=?", id).Scan(&n); e != nil {
			return e
		}
		if n == 0 {
			return problem(404, "NOT_FOUND", "Principal not found")
		}
		if _, e := tx.Exec("INSERT INTO tokens(id,purpose,principal_id,hash,created_at) VALUES(?,?,?,?,?)", v.TokenID, purpose, id, digest([]byte(secret)), s.now().UnixMilli()); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "TOKEN_ISSUED", id, "")
	})
	return v, secret, e
}
func (s *Store) Authenticate(ctx context.Context, secret, purpose string) (Principal, error) {
	var p Principal
	e := s.db.QueryRowContext(ctx, "SELECT principal_id,purpose,id FROM tokens WHERE hash=? AND purpose=? AND revoked=0", digest([]byte(secret)), purpose).Scan(&p.ID, &p.Purpose, &p.TokenID)
	if errors.Is(e, sql.ErrNoRows) {
		return p, problem(401, "UNAUTHORIZED", "Invalid token")
	}
	if e != nil {
		return p, e
	}
	return p, nil
}
func (s *Store) RevokeToken(ctx context.Context, id string) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.Exec("UPDATE tokens SET revoked=1 WHERE id=?", id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return problem(404, "NOT_FOUND", "Token not found")
		}
		if _, e = tx.Exec("UPDATE devices SET session_id='',session_token='',ready_since=0 WHERE session_token=?", id); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "TOKEN_REVOKED", id, "")
	})
}
func (s *Store) Tokens(ctx context.Context) ([]TokenView, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id,purpose,principal_id,created_at,revoked FROM tokens ORDER BY created_at,id")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []TokenView{}
	for rows.Next() {
		var v TokenView
		var at int64
		if e = rows.Scan(&v.TokenID, &v.Purpose, &v.PrincipalID, &at, &v.Revoked); e != nil {
			return nil, e
		}
		v.CreatedAt = stamp(time.UnixMilli(at))
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) Sites(ctx context.Context) ([]Site, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id,name,enabled,weight,operations,revision FROM sites ORDER BY id")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Site{}
	for rows.Next() {
		var v Site
		var ops string
		if e = rows.Scan(&v.ID, &v.Name, &v.Enabled, &v.Weight, &ops, &v.Revision); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(ops), &v.Operations); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) Devices(ctx context.Context) ([]Device, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id,name,enabled,revision FROM devices ORDER BY id")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		var v Device
		if e = rows.Scan(&v.ID, &v.Name, &v.Enabled, &v.Revision); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type jobRow struct {
	seq        int64
	site       string
	request    JobRequest
	view       JobView
	created    int64
	generation int64
	assignment sql.NullString
	attempts   int
}

func loadJob(tx *sql.Tx, site, id string) (jobRow, error) {
	id = strings.ToLower(id)
	var r jobRow
	var req, view []byte
	e := tx.QueryRow("SELECT seq,site_id,request,view,created_at,generation,assignment_id,attempts FROM jobs WHERE site_id=? AND id=?", site, id).Scan(&r.seq, &r.site, &req, &view, &r.created, &r.generation, &r.assignment, &r.attempts)
	if errors.Is(e, sql.ErrNoRows) {
		var n int
		if e = tx.QueryRow("SELECT count(*) FROM tombstones WHERE site_id=? AND id=?", site, id).Scan(&n); e != nil {
			return r, e
		}
		if n > 0 {
			return r, problem(410, "JOB_HISTORY_EXPIRED", "Job history expired")
		}
		return r, problem(404, "NOT_FOUND", "Job not found")
	}
	if e != nil {
		return r, e
	}
	if e = json.Unmarshal(req, &r.request); e != nil {
		return r, e
	}
	if e = json.Unmarshal(view, &r.view); e != nil {
		return r, e
	}
	return r, nil
}
func saveJob(tx *sql.Tx, r *jobRow, now time.Time) error {
	r.view.Revision++
	r.view.UpdatedAt = stamp(now)
	_, e := tx.Exec("UPDATE jobs SET status=?,view=?,updated_at=?,generation=?,assignment_id=?,attempts=? WHERE seq=?", r.view.Status, encode(r.view), now.UnixMilli(), r.generation, r.assignment, r.attempts, r.seq)
	return e
}
func (s *Store) Submit(ctx context.Context, site string, raw []byte) (JobView, bool, error) {
	req, canonical, fp, e := s.validator.Request(raw)
	if e != nil {
		return JobView{}, false, e
	}
	var view JobView
	created := false
	e = s.transaction(ctx, func(tx *sql.Tx) error {
		var oldFP string
		e := tx.QueryRow("SELECT fingerprint FROM jobs WHERE site_id=? AND id=?", site, req.ID).Scan(&oldFP)
		if e == nil {
			if oldFP != fp {
				return problem(409, "IDEMPOTENCY_CONFLICT", "Job ID already has different content")
			}
			r, e := loadJob(tx, site, req.ID)
			if e == nil {
				view = s.decorated(r)
			}
			return e
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		e = tx.QueryRow("SELECT fingerprint FROM tombstones WHERE site_id=? AND id=?", site, req.ID).Scan(&oldFP)
		if e == nil {
			if oldFP != fp {
				return problem(409, "IDEMPOTENCY_CONFLICT", "Job ID already has different content")
			}
			return problem(410, "JOB_HISTORY_EXPIRED", "Job history expired")
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		var enabled bool
		var ops string
		if e = tx.QueryRow("SELECT enabled,operations FROM sites WHERE id=?", site).Scan(&enabled, &ops); errors.Is(e, sql.ErrNoRows) {
			return problem(403, "FORBIDDEN", "Unknown site")
		} else if e != nil {
			return e
		}
		if !enabled {
			return problem(403, "SITE_DISABLED", "New submissions are disabled")
		}
		var allowed []string
		if e = json.Unmarshal([]byte(ops), &allowed); e != nil {
			return e
		}
		now := s.now()
		view = JobView{ProtocolVersion: "2.0", ID: req.ID, Type: req.Type, Status: "QUEUED", Revision: 1, UpdatedAt: stamp(now), Steps: []Step{}}
		supported, e := supportedByAny(tx, req)
		if e != nil {
			return e
		}
		if !contains(allowed, req.Type) || !supported {
			view.Status = "REJECTED"
			view.Error = &APIError{Code: "OPERATION_UNAVAILABLE", Message: "No permitted compatible executor is registered", Permanent: true}
			view.ManualEntryOffered = req.Type != "media.transcode"
		}
		if _, e = tx.Exec("INSERT INTO jobs(site_id,id,fingerprint,request,view,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", site, req.ID, fp, canonical, encode(view), view.Status, now.UnixMilli(), now.UnixMilli()); e != nil {
			return e
		}
		created = view.Status == "QUEUED"
		return audit(tx, now.UnixMilli(), "JOB_"+view.Status, site, req.ID)
	})
	return view, created, e
}
func (s *Store) decorated(r jobRow) JobView {
	v := r.view
	v.QueueDelayed = v.Status == "QUEUED" && s.now().Sub(time.UnixMilli(r.created)) >= s.config.QueueDelay
	return v
}
func (s *Store) Get(ctx context.Context, site, id string) (JobView, error) {
	var v JobView
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := loadJob(tx, site, id)
		if e == nil {
			v = s.decorated(r)
		}
		return e
	})
	return v, e
}
func (s *Store) List(ctx context.Context, site string, after int64, limit int) ([]JobView, int64, error) {
	if limit < 1 || limit > 100 {
		return nil, 0, problem(400, "INVALID_PAGE", "Invalid page limit")
	}
	out := []JobView{}
	var cursor int64
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		rows, e := tx.Query("SELECT seq,view,created_at FROM jobs WHERE site_id=? AND seq>? ORDER BY seq LIMIT ?", site, after, limit)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var r jobRow
			var raw []byte
			if e = rows.Scan(&r.seq, &raw, &r.created); e != nil {
				return e
			}
			if e = json.Unmarshal(raw, &r.view); e != nil {
				return e
			}
			cursor = r.seq
			out = append(out, s.decorated(r))
		}
		return rows.Err()
	})
	return out, cursor, e
}
func terminal(status string) bool {
	return contains([]string{"SUCCEEDED", "PARTIAL", "FAILED", "REJECTED", "CANCELLED", "RELEASED"}, status)
}
func (s *Store) Prune(ctx context.Context) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		cut := s.now().Add(-time.Duration(s.config.HistoryDays) * 24 * time.Hour).UnixMilli()
		pred := "status IN ('SUCCEEDED','PARTIAL','FAILED','REJECTED','CANCELLED','RELEASED') AND updated_at<?"
		if _, e := tx.Exec("INSERT OR IGNORE INTO tombstones(site_id,id,fingerprint,status) SELECT site_id,id,fingerprint,status FROM jobs WHERE "+pred, cut); e != nil {
			return e
		}
		if _, e := tx.Exec("DELETE FROM renewals WHERE assignment_id IN (SELECT id FROM assignments WHERE job_seq IN (SELECT seq FROM jobs WHERE "+pred+"))", cut); e != nil {
			return e
		}
		if _, e := tx.Exec("DELETE FROM assignments WHERE job_seq IN (SELECT seq FROM jobs WHERE "+pred+")", cut); e != nil {
			return e
		}
		if _, e := tx.Exec("DELETE FROM controls WHERE EXISTS (SELECT 1 FROM jobs WHERE jobs.site_id=controls.site_id AND jobs.id=controls.job_id AND "+pred+")", cut); e != nil {
			return e
		}
		if _, e := tx.Exec("DELETE FROM jobs WHERE "+pred, cut); e != nil {
			return e
		}
		_, e := tx.Exec("DELETE FROM audit WHERE at<?", s.now().Add(-time.Duration(s.config.AuditDays)*24*time.Hour).UnixMilli())
		return e
	})
}
func sortParts(parts []SourcePart) {
	sort.Slice(parts, func(i, j int) bool { return parts[i].Path < parts[j].Path })
}
func (s *Store) health(ctx context.Context) error {
	var n int
	return s.db.QueryRowContext(ctx, "SELECT 1").Scan(&n)
}
