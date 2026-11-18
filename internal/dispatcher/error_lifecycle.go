package dispatcher

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const pruneBatch = 200

type ProtectResult struct {
	OK                bool   `json:"ok"`
	ProtectionRemoved bool   `json:"protectionRemoved"`
	Warning           string `json:"warning"`
	RetentionDays     int    `json:"retentionDays"`
}

func unprotectWarning(days int) string {
	return "Снятие защиты вернёт выбранные примеры под TTL " + strconv.Itoa(days) + " дней. Они могут удалиться ближайшей очисткой. Избранное сохраняет примеры отдельно от статуса «исправлено»."
}

func (s *ErrorStore) isProtected(tx *sql.Tx, groupID string) (bool, error) {
	var favorite int
	var status string
	e := tx.QueryRow("SELECT favorite,status FROM error_groups WHERE id=?", groupID).Scan(&favorite, &status)
	if errors.Is(e, sql.ErrNoRows) {
		return false, problem(404, "NOT_FOUND", "Error group not found")
	}
	if e != nil {
		return false, e
	}
	return favorite == 1 || status == "IN_PROGRESS", nil
}

func (s *ErrorStore) pinFirstExample(tx *sql.Tx, groupID string, author string) error {
	var pinned int
	if e := tx.QueryRow("SELECT count(*) FROM error_examples WHERE group_id=?", groupID).Scan(&pinned); e != nil {
		return e
	}
	if pinned > 0 {
		return nil
	}
	var seq int64
	e := tx.QueryRow("SELECT seq FROM error_events WHERE group_id=? ORDER BY seq LIMIT 1", groupID).Scan(&seq)
	if errors.Is(e, sql.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	return s.pinExampleTx(tx, groupID, seq, author)
}

func (s *ErrorStore) pinExampleTx(tx *sql.Tx, groupID string, eventSeq int64, author string) error {
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
}

func (s *ErrorStore) SetFavorite(ctx context.Context, groupID string, favorite bool, author string, confirmUnprotect bool) (ProtectResult, error) {
	out := ProtectResult{RetentionDays: s.config.RetentionDays}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		was, e := s.isProtected(tx, groupID)
		if e != nil {
			return e
		}
		var status string
		if e = tx.QueryRow("SELECT status FROM error_groups WHERE id=?", groupID).Scan(&status); e != nil {
			return e
		}
		willProtect := favorite || status == "IN_PROGRESS"
		if was && !willProtect && !confirmUnprotect {
			return problem(409, "CONFIRM_UNPROTECT", unprotectWarning(s.config.RetentionDays))
		}
		v := 0
		if favorite {
			v = 1
		}
		if _, e = tx.Exec("UPDATE error_groups SET favorite=? WHERE id=?", v, groupID); e != nil {
			return e
		}
		if favorite {
			if e = s.pinFirstExample(tx, groupID, author); e != nil {
				return e
			}
		}
		if e = s.addHistory(tx, groupID, s.now().UnixMilli(), author, "favorite="+strconv.FormatBool(favorite)); e != nil {
			return e
		}
		out.OK = true
		out.ProtectionRemoved = was && !willProtect
		if out.ProtectionRemoved {
			out.Warning = unprotectWarning(s.config.RetentionDays)
		}
		return nil
	})
	return out, e
}

func (s *ErrorStore) SetStatus(ctx context.Context, groupID, status, author string, confirmUnprotect bool) (ProtectResult, error) {
	out := ProtectResult{RetentionDays: s.config.RetentionDays}
	if !contains([]string{"NEW", "IN_PROGRESS", "RESOLVED", "IGNORED"}, status) {
		return out, problem(400, "INVALID_STATUS", "Unknown status")
	}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		was, e := s.isProtected(tx, groupID)
		if e != nil {
			return e
		}
		var old string
		var favorite int
		if e = tx.QueryRow("SELECT status,favorite FROM error_groups WHERE id=?", groupID).Scan(&old, &favorite); e != nil {
			return e
		}
		willProtect := favorite == 1 || status == "IN_PROGRESS"
		if was && !willProtect && !confirmUnprotect {
			return problem(409, "CONFIRM_UNPROTECT", unprotectWarning(s.config.RetentionDays))
		}
		if old != status {
			if _, e = tx.Exec("UPDATE error_groups SET status=? WHERE id=?", status, groupID); e != nil {
				return e
			}
			if e = s.addHistory(tx, groupID, s.now().UnixMilli(), author, "status="+old+"->"+status); e != nil {
				return e
			}
		}
		if status == "IN_PROGRESS" {
			if e = s.pinFirstExample(tx, groupID, author); e != nil {
				return e
			}
		}
		out.OK = true
		out.ProtectionRemoved = was && !willProtect
		if out.ProtectionRemoved {
			out.Warning = unprotectWarning(s.config.RetentionDays)
		}
		return nil
	})
	return out, e
}

func (s *ErrorStore) PinExample(ctx context.Context, groupID string, eventSeq int64, author string) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		return s.pinExampleTx(tx, groupID, eventSeq, author)
	})
}

func (s *ErrorStore) UnpinExample(ctx context.Context, groupID string, eventSeq int64, author string) (ProtectResult, error) {
	out := ProtectResult{OK: true, RetentionDays: s.config.RetentionDays}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.Exec("DELETE FROM error_examples WHERE group_id=? AND event_seq=?", groupID, eventSeq)
		if e != nil {
			return e
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return problem(404, "NOT_FOUND", "Saved example not found")
		}
		if _, e = tx.Exec("UPDATE error_groups SET pinned_examples=(SELECT count(*) FROM error_examples WHERE group_id=?) WHERE id=?", groupID, groupID); e != nil {
			return e
		}
		return s.addHistory(tx, groupID, s.now().UnixMilli(), author, "example-unpinned")
	})
	return out, e
}

func (s *ErrorStore) AddNote(ctx context.Context, groupID, author, text string) error {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 4000 {
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

func (s *ErrorStore) SetRetention(ctx context.Context, days int) (map[string]any, error) {
	if days < 7 || days > 21 {
		return nil, problem(400, "INVALID_SETTINGS", "Retention must be 7 to 21 days")
	}
	prev := s.config.RetentionDays
	s.config.RetentionDays = days
	if _, e := s.db.ExecContext(ctx, "UPDATE error_settings SET value=? WHERE key='retention_days'", strconv.Itoa(days)); e != nil {
		s.config.RetentionDays = prev
		return nil, e
	}
	warning := ""
	if days < prev {
		warning = "Меньший срок применится к незащищённым событиям при следующей очистке. Избранное и разбор не удаляются."
	}
	return map[string]any{
		"retentionDays":         days,
		"ttlAppliesOnNextPrune": true,
		"maxSavedExamples":      s.config.MaxSavedExamples,
		"maxDbBytes":            s.config.MaxDBBytes,
		"warning":               warning,
	}, nil
}

func (s *ErrorStore) SettingsView() map[string]any {
	return map[string]any{
		"retentionDays":         s.config.RetentionDays,
		"ttlAppliesOnNextPrune": true,
		"maxSavedExamples":      s.config.MaxSavedExamples,
		"maxDbBytes":            s.config.MaxDBBytes,
		"warning":               "",
	}
}

func pinnedSelect() string {
	return `SELECT e.event_seq FROM error_examples e JOIN error_groups g ON g.id = e.group_id
		WHERE g.favorite = 1 OR g.status = 'IN_PROGRESS'`
}

func (s *ErrorStore) Prune(ctx context.Context) error {
	_, e := s.PruneCounted(ctx)
	return e
}

func (s *ErrorStore) PruneCounted(ctx context.Context) (int, error) {
	cutoff := s.now().Add(-time.Duration(s.config.RetentionDays) * 24 * time.Hour).UnixMilli()
	removed := 0
	for {
		var n int64
		e := s.transaction(ctx, func(tx *sql.Tx) error {
			r, e := tx.Exec(`DELETE FROM error_events WHERE seq IN (
				SELECT seq FROM error_events WHERE received_at < ? AND seq NOT IN (`+pinnedSelect()+`)
				ORDER BY received_at, seq LIMIT ?)`, cutoff, pruneBatch)
			if e != nil {
				return e
			}
			n, _ = r.RowsAffected()
			if _, e = tx.Exec(`DELETE FROM error_groups WHERE id NOT IN (SELECT DISTINCT group_id FROM error_events)
				AND favorite=0 AND status!='IN_PROGRESS'`); e != nil {
				return e
			}
			return nil
		})
		if e != nil {
			s.recordPrune(0, e)
			return removed, e
		}
		removed += int(n)
		if n == 0 {
			break
		}
	}
	_ = s.Checkpoint(ctx)
	_, _ = s.db.ExecContext(ctx, "PRAGMA incremental_vacuum(64)")
	s.recordPrune(removed, nil)
	return removed, nil
}

func (s *ErrorStore) recordPrune(removed int, err error) {
	msg := ""
	if err != nil {
		msg = clip(err.Error(), 1000)
	}
	_, _ = s.db.Exec(`UPDATE error_settings SET value=? WHERE key='last_prune_at'`, stamp(s.now()))
	_, _ = s.db.Exec(`UPDATE error_settings SET value=? WHERE key='last_prune_error'`, msg)
	_, _ = s.db.Exec(`UPDATE error_settings SET value=? WHERE key='last_prune_removed'`, strconv.Itoa(removed))
}

func (s *ErrorStore) Snapshot(ctx context.Context, keep int) (string, error) {
	if keep < 1 {
		keep = defaultBackupKeep
	}
	dir := filepath.Join(filepath.Dir(s.path), "backups")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	name := "errors-" + s.now().UTC().Format("20060102T150405Z") + ".db"
	dest := filepath.Join(dir, name)
	if _, e := s.db.ExecContext(ctx, "VACUUM INTO "+sqliteLiteral(dest)); e != nil {
		return "", e
	}
	_ = os.Chmod(dest, 0600)
	pruneBackupPrefixed(dir, "errors-", keep)
	return dest, nil
}

func RestoreErrors(dbPath, from string) error {
	if strings.TrimSpace(from) == "" {
		return errors.New("restore-errors requires -from")
	}
	path, e := filepath.Abs(dbPath)
	if e != nil {
		return e
	}
	src, e := filepath.Abs(from)
	if e != nil {
		return e
	}
	if _, e = os.Stat(src); e != nil {
		return e
	}
	lock := flock.New(path + ".lock")
	ok, e := lock.TryLock()
	if e != nil {
		return e
	}
	if !ok {
		return errors.New("another dispatcher owns this diagnostics database; stop it before restore")
	}
	defer lock.Unlock()
	if e = copyFile(src, path); e != nil {
		return e
	}
	_ = os.Remove(path + "-wal")
	_ = os.Remove(path + "-shm")
	return nil
}

// DiagnosticsStatus is the owner-visible size and loss counters for the journal.
type DiagnosticsStatus struct {
	Events            int    `json:"events"`
	Groups            int    `json:"groups"`
	DBBytes           int64  `json:"dbBytes"`
	FreeBytes         int64  `json:"freeBytes"`
	MaxDBBytes        int64  `json:"maxDbBytes"`
	ProtectedExamples int    `json:"protectedExamples"`
	ProtectedBytes    int64  `json:"protectedBytes"`
	LostQuota         int    `json:"lostQuota"`
	LostDisk          int    `json:"lostDisk"`
	LostSpam          int    `json:"lostSpam"`
	LostFallback      int    `json:"lostFallback"`
	RetentionDays     int    `json:"retentionDays"`
	DiskWarning       bool   `json:"diskWarning"`
	LastPruneAt       any    `json:"lastPruneAt"`
	LastPruneError    string `json:"lastPruneError"`
	LastPruneRemoved  int    `json:"lastPruneRemoved"`
}

func (s *ErrorStore) Status(ctx context.Context) (DiagnosticsStatus, error) {
	st := DiagnosticsStatus{RetentionDays: s.config.RetentionDays, MaxDBBytes: s.config.MaxDBBytes, LastPruneAt: nil}
	if info, e := os.Stat(s.path); e == nil {
		st.DBBytes = info.Size()
	}
	budget := s.config.MaxDBBytes - st.DBBytes
	if budget < 0 {
		budget = 0
	}
	vol := volumeFree(s.path)
	st.FreeBytes = budget
	if vol > 0 && (st.FreeBytes == 0 || vol < st.FreeBytes) {
		st.FreeBytes = vol
	}
	if e := s.db.QueryRowContext(ctx, "SELECT count(*) FROM error_events").Scan(&st.Events); e != nil {
		return st, e
	}
	if e := s.db.QueryRowContext(ctx, "SELECT count(*) FROM error_groups").Scan(&st.Groups); e != nil {
		return st, e
	}
	_ = s.db.QueryRowContext(ctx, `SELECT count(*), coalesce(sum(length(ev.message)+length(ev.stack)+length(ev.context)),0)
		FROM error_examples x JOIN error_events ev ON ev.seq=x.event_seq
		JOIN error_groups g ON g.id=x.group_id WHERE g.favorite=1 OR g.status='IN_PROGRESS'`).Scan(&st.ProtectedExamples, &st.ProtectedBytes)
	read := func(key string, dest *int) {
		var raw string
		if s.db.QueryRowContext(ctx, "SELECT value FROM error_settings WHERE key=?", key).Scan(&raw) == nil {
			*dest, _ = strconv.Atoi(raw)
		}
	}
	read("lost_quota", &st.LostQuota)
	read("lost_disk", &st.LostDisk)
	read("lost_spam", &st.LostSpam)
	read("lost_fallback", &st.LostFallback)
	read("last_prune_removed", &st.LastPruneRemoved)
	var pruneAt, pruneErr string
	_ = s.db.QueryRowContext(ctx, "SELECT value FROM error_settings WHERE key='last_prune_at'").Scan(&pruneAt)
	_ = s.db.QueryRowContext(ctx, "SELECT value FROM error_settings WHERE key='last_prune_error'").Scan(&pruneErr)
	if pruneAt != "" {
		st.LastPruneAt = pruneAt
	}
	st.LastPruneError = pruneErr
	st.DiskWarning = st.DBBytes*5 >= s.config.MaxDBBytes*4 || (vol > 0 && vol < 64<<20)
	return st, nil
}

func (s *ErrorStore) StartBackupLoop(ctx context.Context) {
	go func() {
		timer := time.NewTimer(time.Until(nextUTCBackup()))
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				_, _ = s.Snapshot(context.Background(), defaultBackupKeep)
				timer.Reset(time.Until(nextUTCBackup()))
			}
		}
	}()
}
