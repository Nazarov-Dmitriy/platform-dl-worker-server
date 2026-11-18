package dispatcher

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
	_ "modernc.org/sqlite"
)

//go:embed migrations/errors/*.sql
var errorMigrations embed.FS

// Diagnostic ingress limits. Senders reject oversized batches and fields with a
// clear code; the journal never stores more than these per delivery.
const (
	maxEventsPerBatch = 50
	maxBatchBytes     = 256 << 10
	maxMessageBytes   = 2 << 10
	maxStackBytes     = 32 << 10
	maxContextBytes   = 16 << 10
	maxCauseBytes     = 4 << 10
	maxBreadcrumbs    = 20
	maxSavedExamples  = 10
)

// ErrorJournalConfig holds tunable storage policy for the diagnostics journal.
type ErrorJournalConfig struct {
	RetentionDays    int // 7..21, default 14
	MaxSavedExamples int // default 10
}

func DefaultErrorJournalConfig() ErrorJournalConfig {
	return ErrorJournalConfig{RetentionDays: 14, MaxSavedExamples: 10}
}

func (c ErrorJournalConfig) validate() error {
	if c.RetentionDays < 7 || c.RetentionDays > 21 || c.MaxSavedExamples < 1 || c.MaxSavedExamples > 100 {
		return errors.New("invalid error journal configuration")
	}
	return nil
}

// ErrorStore is the diagnostics journal, kept in its own SQLite file so the
// main job queue keeps a small write path and the journal prunes/backs up
// independently.
type ErrorStore struct {
	db     *sql.DB
	lock   *flock.Flock
	config ErrorJournalConfig
	now    func() time.Time
	path   string
}

// OpenErrors opens (and migrates) the diagnostics database at path.
func OpenErrors(path string, config ErrorJournalConfig) (*ErrorStore, error) {
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
		return nil, errors.New("another dispatcher owns this diagnostics database")
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
	s := &ErrorStore{db: db, lock: lock, config: config, now: time.Now, path: path}
	fail := func(e error) (*ErrorStore, error) { _ = s.Close(); return nil, e }
	if e = db.Ping(); e != nil {
		return fail(e)
	}
	var exists int
	if e = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'").Scan(&exists); e != nil {
		return fail(e)
	}
	version := 0
	if exists != 0 {
		if e = db.QueryRow("SELECT max(version) FROM schema_migrations").Scan(&version); e != nil {
			return fail(e)
		}
	}
	if version > 1 {
		return fail(errors.New("unsupported diagnostics database schema version"))
	}
	if version < 1 {
		raw, err := errorMigrations.ReadFile("migrations/errors/001_core.sql")
		if err != nil {
			return fail(err)
		}
		tx, err := db.Begin()
		if err != nil {
			return fail(err)
		}
		if _, err = tx.Exec(string(raw)); err != nil {
			_ = tx.Rollback()
			return fail(err)
		}
		if err = tx.Commit(); err != nil {
			return fail(err)
		}
	}
	if e = s.seedSettings(); e != nil {
		return fail(e)
	}
	return s, nil
}

func (s *ErrorStore) seedSettings() error {
	_, e := s.db.Exec("INSERT OR IGNORE INTO error_settings(key,value) VALUES('retention_days',?),('max_saved_examples',?)",
		strconv.Itoa(s.config.RetentionDays), strconv.Itoa(s.config.MaxSavedExamples))
	return e
}

func (s *ErrorStore) Close() error {
	e := s.db.Close()
	if u := s.lock.Unlock(); e == nil {
		e = u
	}
	return e
}

func (s *ErrorStore) Path() string { return s.path }

// Now returns the clock used for receivedAt, so ACKs match what was stored.
func (s *ErrorStore) Now() time.Time { return s.now() }

func (s *ErrorStore) transaction(ctx context.Context, run func(*sql.Tx) error) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = run(tx); e != nil {
		return e
	}
	return tx.Commit()
}

// DiagnosticsBreadcrumb is one safe navigation step captured by the sender.
type DiagnosticsBreadcrumb struct {
	At       string `json:"at"`
	Category string `json:"category"`
	Message  string `json:"message"`
	Data     string `json:"data"`
}

// DiagnosticsEvent is a single diagnostic delivery (Event v1).
type DiagnosticsEvent struct {
	EventID     string                  `json:"eventId"`
	OccurredAt  string                  `json:"occurredAt"`
	Source      string                  `json:"source"`
	Service     string                  `json:"service"`
	Environment string                  `json:"environment"`
	Release     string                  `json:"release"`
	Severity    string                  `json:"severity"`
	Code        string                  `json:"code"`
	Module      string                  `json:"module"`
	Operation   string                  `json:"operation"`
	Stage       string                  `json:"stage"`
	Message     string                  `json:"message"`
	Cause       string                  `json:"cause"`
	Stack       string                  `json:"stack"`
	Context     string                  `json:"context"`
	Breadcrumbs []DiagnosticsBreadcrumb `json:"breadcrumbs,omitempty"`
	RequestID   string                  `json:"requestId"`
	OperationID string                  `json:"operationId"`
	ResourceID  string                  `json:"resourceId"`
	JobID       string                  `json:"jobId"`
	DeviceID    string                  `json:"deviceId"`
}

func (e DiagnosticsEvent) validate() error {
	if strings.TrimSpace(e.EventID) == "" || len(e.EventID) > 1000 {
		return problem(400, "INVALID_EVENT", "Diagnostics eventId is required")
	}
	if _, err := time.Parse(time.RFC3339, e.OccurredAt); err != nil {
		return problem(400, "INVALID_EVENT", "Diagnostics occurredAt must be an RFC3339 timestamp")
	}
	if !contains([]string{"front", "back", "worker"}, e.Source) {
		return problem(400, "INVALID_EVENT", "Diagnostics source must be front, back or worker")
	}
	if strings.TrimSpace(e.Message) == "" || len(e.Message) > maxMessageBytes {
		return problem(400, "INVALID_EVENT", "Diagnostics message is required (max 2 KiB)")
	}
	if len(e.Stack) > maxStackBytes {
		return problem(400, "INVALID_EVENT", "Diagnostics stack exceeds 32 KiB")
	}
	if len(e.Context) > maxContextBytes {
		return problem(400, "INVALID_EVENT", "Diagnostics context exceeds 16 KiB")
	}
	if len(e.Cause) > maxCauseBytes {
		return problem(400, "INVALID_EVENT", "Diagnostics cause exceeds 4 KiB")
	}
	if len(e.Breadcrumbs) > maxBreadcrumbs {
		return problem(400, "INVALID_EVENT", "Too many diagnostics breadcrumbs")
	}
	for _, b := range e.Breadcrumbs {
		if len(b.Message) > maxMessageBytes || len(b.Data) > maxCauseBytes {
			return problem(400, "INVALID_EVENT", "Diagnostics breadcrumb exceeds limits")
		}
		if _, err := time.Parse(time.RFC3339, b.At); err != nil {
			return problem(400, "INVALID_EVENT", "Diagnostics breadcrumb at must be an RFC3339 timestamp")
		}
	}
	return nil
}

// DiagnosticsSender is the trusted identity resolved from the ingress channel:
// a site token for the sites area, or the worker component for the system area.
// The event's own source (front/back/worker) is validated against the channel
// before Record is called and is what the fingerprint groups on.
type DiagnosticsSender struct {
	ID     string // trusted sender identity: site id or worker component/device id
	Area   string // "sites" or "worker"
	SiteID string // site id when area=sites, empty for worker
}

// Record validates and stores one batch atomically: an invalid batch is
// rejected without a partial write, and replayed eventId values are counted as
// duplicates rather than creating a second case.
func (s *ErrorStore) Record(ctx context.Context, sender DiagnosticsSender, events []DiagnosticsEvent) (accepted, duplicates int, err error) {
	if len(events) == 0 || len(events) > maxEventsPerBatch {
		return 0, 0, problem(400, "INVALID_BATCH", "A diagnostics batch needs 1..50 events")
	}
	for _, ev := range events {
		if e := ev.validate(); e != nil {
			return 0, 0, e
		}
	}
	receivedAt := s.now().UnixMilli()
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		for _, ev := range events {
			dup, e := s.recordEvent(tx, sender, receivedAt, ev)
			if e != nil {
				return e
			}
			if dup {
				duplicates++
			} else {
				accepted++
			}
		}
		return nil
	})
	if e != nil {
		return 0, 0, e
	}
	return accepted, duplicates, nil
}

func (s *ErrorStore) recordEvent(tx *sql.Tx, sender DiagnosticsSender, receivedAt int64, ev DiagnosticsEvent) (bool, error) {
	var n int
	if e := tx.QueryRow("SELECT count(*) FROM error_events WHERE sender_id=? AND event_id=?", sender.ID, ev.EventID).Scan(&n); e != nil {
		return false, e
	}
	if n > 0 {
		// Replayed delivery: acknowledge without creating a second case.
		return true, nil
	}
	fp := diagnosticsFingerprint(sender.Area, sender.SiteID, ev.Source, ev.Service, ev.Environment, ev.Code, ev.Module, ev.Operation, ev.Stack)
	var groupID, currentStatus string
	e := tx.QueryRow("SELECT id,status FROM error_groups WHERE fingerprint=?", fp).Scan(&groupID, &currentStatus)
	if errors.Is(e, sql.ErrNoRows) {
		groupID = UUID()
		if _, e = tx.Exec(`INSERT INTO error_groups(id,fingerprint,area,site_id,source,service,environment,code,module,operation,status,favorite,first_seen,last_seen,occurrences,pinned_examples,created_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,'NEW',0,?,?,0,0,?)`,
			groupID, fp, sender.Area, sender.SiteID, ev.Source, ev.Service, ev.Environment, ev.Code, ev.Module, ev.Operation, receivedAt, receivedAt, receivedAt); e != nil {
			return false, e
		}
	} else if e != nil {
		return false, e
	}
	occurredAt, e := time.Parse(time.RFC3339, ev.OccurredAt)
	if e != nil {
		return false, e
	}
	if _, e = tx.Exec(`INSERT INTO error_events(group_id,sender_id,event_id,area,site_id,source,service,environment,release,severity,code,module,operation,stage,occurred_at,received_at,message,cause,stack,context,breadcrumbs,request_id,operation_id,resource_id,job_id,device_id)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		groupID, sender.ID, ev.EventID, sender.Area, sender.SiteID, ev.Source, ev.Service, ev.Environment, ev.Release, ev.Severity, ev.Code, ev.Module, ev.Operation, ev.Stage,
		occurredAt.UnixMilli(), receivedAt, ev.Message, ev.Cause, ev.Stack, ev.Context, string(encode(ev.Breadcrumbs)), ev.RequestID, ev.OperationID, ev.ResourceID, ev.JobID, ev.DeviceID); e != nil {
		return false, e
	}
	if _, e = tx.Exec("UPDATE error_groups SET last_seen=?,occurrences=occurrences+1,status=CASE WHEN status='RESOLVED' THEN 'NEW' ELSE status END WHERE id=?", receivedAt, groupID); e != nil {
		return false, e
	}
	if currentStatus == "RESOLVED" {
		if e = s.addHistory(tx, groupID, receivedAt, "", "status=RESOLVED->NEW"); e != nil {
			return false, e
		}
	}
	return false, nil
}

// diagnosticsFingerprint is Fingerprint v1: stable fields plus a normalized
// stack signature and error type. It deliberately excludes eventId, time,
// resourceId, requestId, release and dynamic message text, so a repeat after a
// fix still lands in the same group.
func diagnosticsFingerprint(area, siteID, source, service, environment, code, module, operation, stack string) string {
	raw := strings.Join([]string{"v1", area, siteID, source, service, environment, code, module, operation, errorType(stack), normalizeStack(stack)}, "\x00")
	return digest([]byte(raw))
}

var frameParens = regexp.MustCompile(`\([^)]*\)`)
var frameDigits = regexp.MustCompile(`0x[0-9a-fA-F]+|[0-9]+`)

// normalizeStack keeps only the frame names: line numbers, columns, memory
// addresses and dynamic arguments inside parentheses are dropped.
func normalizeStack(stack string) string {
	var out []string
	for _, line := range strings.Split(stack, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		line = strings.TrimPrefix(line, "at ")
		line = frameParens.ReplaceAllString(line, "")
		line = frameDigits.ReplaceAllString(line, "")
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

// errorType extracts the leading error identifier from the first stack line,
// e.g. "TypeError" from "TypeError: ..." or "panic" from "panic: ...".
func errorType(stack string) string {
	first := ""
	for _, line := range strings.Split(stack, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			first = line
			break
		}
	}
	if strings.HasPrefix(first, "panic") {
		return "panic"
	}
	if i := strings.IndexAny(first, ":("); i >= 0 {
		first = strings.TrimSpace(first[:i])
	}
	return first
}

// Prune applies the TTL policy: unprotected events older than RetentionDays
// are removed, saved examples of protected groups (favorite or IN_PROGRESS)
// survive, and groups left without any event are dropped.
func (s *ErrorStore) Prune(ctx context.Context) error {
	cutoff := s.now().Add(-time.Duration(s.config.RetentionDays) * 24 * time.Hour).UnixMilli()
	return s.transaction(ctx, func(tx *sql.Tx) error {
		if _, e := tx.Exec(`DELETE FROM error_events WHERE received_at < ? AND seq NOT IN (
			SELECT e.event_seq FROM error_examples e JOIN error_groups g ON g.id = e.group_id
			WHERE g.favorite = 1 OR g.status = 'IN_PROGRESS')`, cutoff); e != nil {
			return e
		}
		if _, e := tx.Exec("DELETE FROM error_groups WHERE id NOT IN (SELECT DISTINCT group_id FROM error_events)"); e != nil {
			return e
		}
		return nil
	})
}

// SetFavorite toggles protection of a card independently from its status.
func (s *ErrorStore) SetFavorite(ctx context.Context, groupID string, favorite bool, author string) error {
	v := 0
	if favorite {
		v = 1
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.Exec("UPDATE error_groups SET favorite=? WHERE id=?", v, groupID)
		if e != nil {
			return e
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return problem(404, "NOT_FOUND", "Error group not found")
		}
		return s.addHistory(tx, groupID, s.now().UnixMilli(), author, "favorite="+strconv.FormatBool(favorite))
	})
}

// SetStatus applies a resolution transition and keeps a history entry.
func (s *ErrorStore) SetStatus(ctx context.Context, groupID, status, author string) error {
	if !contains([]string{"NEW", "IN_PROGRESS", "RESOLVED", "IGNORED"}, status) {
		return problem(400, "INVALID_STATUS", "Unknown status")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		var old string
		e := tx.QueryRow("SELECT status FROM error_groups WHERE id=?", groupID).Scan(&old)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Error group not found")
		}
		if e != nil {
			return e
		}
		if old == status {
			return nil
		}
		if _, e = tx.Exec("UPDATE error_groups SET status=? WHERE id=?", status, groupID); e != nil {
			return e
		}
		return s.addHistory(tx, groupID, s.now().UnixMilli(), author, "status="+old+"->"+status)
	})
}

// PinExample saves a diagnostic example with the protected card.
func (s *ErrorStore) PinExample(ctx context.Context, groupID string, eventSeq int64, author string) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		var n int
		if e := tx.QueryRow("SELECT count(*) FROM error_events WHERE group_id=? AND seq=?", groupID, eventSeq).Scan(&n); e != nil {
			return e
		}
		if n == 0 {
			return problem(404, "NOT_FOUND", "Event not found")
		}
		var pinned int
		if e := tx.QueryRow("SELECT count(*) FROM error_examples WHERE group_id=?", groupID).Scan(&pinned); e != nil {
			return e
		}
		if pinned >= s.config.MaxSavedExamples {
			return problem(409, "EXAMPLES_LIMIT", "Too many saved examples for this group")
		}
		if _, e := tx.Exec("INSERT OR IGNORE INTO error_examples(group_id,event_seq,saved_at) VALUES(?,?,?)", groupID, eventSeq, s.now().UnixMilli()); e != nil {
			return e
		}
		if _, e := tx.Exec("UPDATE error_groups SET pinned_examples=(SELECT count(*) FROM error_examples WHERE group_id=?) WHERE id=?", groupID, groupID); e != nil {
			return e
		}
		return s.addHistory(tx, groupID, s.now().UnixMilli(), author, "example-pinned")
	})
}

// AddNote appends an owner note to a group.
func (s *ErrorStore) AddNote(ctx context.Context, groupID, author, text string) error {
	if strings.TrimSpace(text) == "" {
		return problem(400, "INVALID_NOTE", "Note text is required")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		var n int
		if e := tx.QueryRow("SELECT count(*) FROM error_groups WHERE id=?", groupID).Scan(&n); e != nil {
			return e
		}
		if n == 0 {
			return problem(404, "NOT_FOUND", "Error group not found")
		}
		_, e := tx.Exec("INSERT INTO error_notes(group_id,at,author,text) VALUES(?,?,?,?)", groupID, s.now().UnixMilli(), author, text)
		return e
	})
}

func (s *ErrorStore) addHistory(tx *sql.Tx, groupID string, at int64, author, change string) error {
	_, e := tx.Exec("INSERT INTO error_history(group_id,at,author,change) VALUES(?,?,?,?)", groupID, at, author, change)
	return e
}
