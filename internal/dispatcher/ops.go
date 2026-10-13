package dispatcher

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const defaultBackupKeep = 7

type OpsStatus struct {
	Maintenance        bool     `json:"maintenance"`
	Epoch              string   `json:"epoch"`
	RestoreGeneration  int      `json:"restoreGeneration"`
	Queued             int      `json:"queued"`
	Offered            int      `json:"offered"`
	Running            int      `json:"running"`
	LastBackup         string   `json:"lastBackup,omitempty"`
	Backups            []string `json:"backups"`
	UpdateReady        bool     `json:"updateReady"`
	SnapshotIncomplete bool     `json:"snapshotDoesNotIncludeLaterChanges"`
}

func (s *Store) OpsStatus(ctx context.Context) (OpsStatus, error) {
	st := OpsStatus{Epoch: s.epoch, Backups: []string{}, SnapshotIncomplete: true}
	var maint, last string
	var gen int
	_ = s.db.QueryRowContext(ctx, "SELECT value FROM metadata WHERE key='maintenance'").Scan(&maint)
	_ = s.db.QueryRowContext(ctx, "SELECT value FROM metadata WHERE key='last_backup'").Scan(&last)
	_ = s.db.QueryRowContext(ctx, "SELECT CAST(value AS INTEGER) FROM metadata WHERE key='restore_generation'").Scan(&gen)
	st.Maintenance = maint == "1"
	st.LastBackup = last
	st.RestoreGeneration = gen
	if e := s.db.QueryRowContext(ctx, "SELECT count(*) FROM jobs WHERE status='QUEUED'").Scan(&st.Queued); e != nil {
		return st, e
	}
	if e := s.db.QueryRowContext(ctx, "SELECT count(*) FROM assignments WHERE state='OFFERED'").Scan(&st.Offered); e != nil {
		return st, e
	}
	if e := s.db.QueryRowContext(ctx, "SELECT count(*) FROM assignments WHERE state IN ('RUNNING','CANCELLING','RELEASING')").Scan(&st.Running); e != nil {
		return st, e
	}
	st.UpdateReady = st.Maintenance && st.Running == 0 && st.Offered == 0
	st.Backups = listBackupNames(s.backupDir())
	return st, nil
}

func (s *Store) SetMaintenance(ctx context.Context, a AdminActor, enabled bool) (OpsStatus, error) {
	if e := requireOwner(a); e != nil {
		return OpsStatus{}, e
	}
	v := "0"
	kind := "MAINTENANCE_OFF"
	if enabled {
		v = "1"
		kind = "MAINTENANCE_ON"
	}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		if _, e := tx.Exec("INSERT INTO metadata(key,value) VALUES('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", v); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), kind, a.ID, "")
	})
	if e != nil {
		return OpsStatus{}, e
	}
	return s.OpsStatus(ctx)
}

func (s *Store) backupDir() string {
	return filepath.Join(filepath.Dir(s.path), "backups")
}

func (s *Store) Snapshot(ctx context.Context, keep int) (string, error) {
	if keep < 1 {
		keep = defaultBackupKeep
	}
	if e := s.health(ctx); e != nil {
		return "", e
	}
	dir := s.backupDir()
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	name := "dispatcher-" + s.now().UTC().Format("20060102T150405Z") + ".db"
	dest := filepath.Join(dir, name)
	if _, e := s.db.ExecContext(ctx, "VACUUM INTO "+sqliteLiteral(dest)); e != nil {
		return "", e
	}
	_ = os.Chmod(dest, 0600)
	if _, e := s.db.ExecContext(ctx, "INSERT INTO metadata(key,value) VALUES('last_backup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", dest); e != nil {
		return dest, e
	}
	pruneBackupDir(dir, keep)
	if uri := strings.TrimSpace(os.Getenv("DISPATCHER_BACKUP_S3_URI")); uri != "" {
		if e := copyBackupToS3(dest, uri); e != nil {
			return dest, e
		}
	}
	return dest, nil
}

func (s *Store) AdminSnapshot(ctx context.Context, a AdminActor, keep int) (map[string]any, error) {
	if e := requireOwner(a); e != nil {
		return nil, e
	}
	path, e := s.Snapshot(ctx, keep)
	if e != nil {
		return nil, e
	}
	_ = s.transaction(ctx, func(tx *sql.Tx) error {
		return audit(tx, s.now().UnixMilli(), "BACKUP", a.ID, filepath.Base(path))
	})
	st, e := s.OpsStatus(ctx)
	if e != nil {
		return nil, e
	}
	return map[string]any{"path": path, "ops": st}, nil
}

func (s *Store) PrepareUpdate(ctx context.Context, a AdminActor) (map[string]any, error) {
	st, e := s.SetMaintenance(ctx, a, true)
	if e != nil {
		return nil, e
	}
	if st.Running > 0 || st.Offered > 0 {
		return map[string]any{"ops": st, "snapshot": "", "message": "Wait until offered and running assignments reach zero, then retry"}, nil
	}
	path, e := s.Snapshot(ctx, defaultBackupKeep)
	if e != nil {
		return nil, e
	}
	st, e = s.OpsStatus(ctx)
	if e != nil {
		return nil, e
	}
	return map[string]any{"ops": st, "snapshot": path, "message": "Replace the dispatcher image, then docker compose up. Rollback uses restore from this snapshot if the schema is incompatible."}, nil
}

func (s *Store) SealRestore(ctx context.Context) (string, error) {
	next := UUID()
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var gen int
		_ = tx.QueryRow("SELECT CAST(value AS INTEGER) FROM metadata WHERE key='restore_generation'").Scan(&gen)
		gen++
		if _, e := tx.Exec("UPDATE metadata SET value=? WHERE key='epoch'", next); e != nil {
			return e
		}
		if _, e := tx.Exec("INSERT INTO metadata(key,value) VALUES('restore_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", itoa(gen)); e != nil {
			return e
		}
		if _, e := tx.Exec("INSERT INTO metadata(key,value) VALUES('maintenance','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value"); e != nil {
			return e
		}
		now := s.now()
		rows, e := tx.Query("SELECT a.id,a.job_seq,a.state,j.site_id,j.id FROM assignments a JOIN jobs j ON j.seq=a.job_seq WHERE a.state!='CLOSED'")
		if e != nil {
			return e
		}
		type item struct {
			a        assignment
			site, id string
		}
		list := []item{}
		for rows.Next() {
			var x item
			if e = rows.Scan(&x.a.id, &x.a.seq, &x.a.state, &x.site, &x.id); e != nil {
				rows.Close()
				return e
			}
			list = append(list, x)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		cause := &APIError{Code: "DISPATCHER_RESTORED", Message: "Assignment closed after dispatcher restore; previous epoch results are rejected", Permanent: true}
		for _, x := range list {
			r, e := loadJob(tx, x.site, x.id)
			if e != nil {
				return e
			}
			status := "QUEUED"
			if x.a.state == "CANCELLING" || x.a.state == "RELEASING" {
				status = "CANCELLED"
			}
			r.generation++
			if e = s.closeAssignment(tx, &r, x.a, status, cause, now); e != nil {
				return e
			}
		}
		s.epoch = next
		return audit(tx, now.UnixMilli(), "RESTORE_SEALED", "dispatcher", next)
	})
	return next, e
}

func RestoreDatabase(dbPath, from string, config Config) (string, error) {
	if strings.TrimSpace(from) == "" {
		return "", errors.New("restore requires -from")
	}
	path, e := filepath.Abs(dbPath)
	if e != nil {
		return "", e
	}
	src, e := filepath.Abs(from)
	if e != nil {
		return "", e
	}
	if _, e = os.Stat(src); e != nil {
		return "", e
	}
	lock := flock.New(path + ".lock")
	ok, e := lock.TryLock()
	if e != nil {
		return "", e
	}
	if !ok {
		return "", errors.New("another dispatcher owns this database; stop it before restore")
	}
	if e = copyFile(src, path); e != nil {
		_ = lock.Unlock()
		return "", e
	}
	_ = os.Remove(path + "-wal")
	_ = os.Remove(path + "-shm")
	if e = lock.Unlock(); e != nil {
		return "", e
	}
	s, e := Open(path, config)
	if e != nil {
		return "", e
	}
	defer s.Close()
	return s.SealRestore(context.Background())
}

func sqliteLiteral(path string) string {
	return "'" + strings.ReplaceAll(filepath.ToSlash(path), "'", "''") + "'"
}

func listBackupNames(dir string) []string {
	ents, e := os.ReadDir(dir)
	if e != nil {
		return []string{}
	}
	names := []string{}
	for _, ent := range ents {
		if !ent.IsDir() && strings.HasPrefix(ent.Name(), "dispatcher-") && strings.HasSuffix(ent.Name(), ".db") {
			names = append(names, ent.Name())
		}
	}
	sort.Strings(names)
	return names
}

func pruneBackupDir(dir string, keep int) {
	names := listBackupNames(dir)
	if len(names) <= keep {
		return
	}
	for _, name := range names[:len(names)-keep] {
		_ = os.Remove(filepath.Join(dir, name))
	}
}

func copyBackupToS3(path, uri string) error {
	if _, e := exec.LookPath("aws"); e != nil {
		return errors.New("local snapshot written; aws CLI not found for DISPATCHER_BACKUP_S3_URI")
	}
	dest := strings.TrimRight(uri, "/") + "/" + filepath.Base(path)
	cmd := exec.Command("aws", "s3", "cp", path, dest)
	cmd.Env = os.Environ()
	out, e := cmd.CombinedOutput()
	if e != nil {
		return errors.New(strings.TrimSpace(string(out) + " " + e.Error()))
	}
	return nil
}

func copyFile(src, dst string) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	if e = os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
		return e
	}
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = io.Copy(out, in); e != nil {
		_ = out.Close()
		return e
	}
	return out.Close()
}

func itoa(n int) string { return strconv.Itoa(n) }

func (s *Store) StartBackupLoop(ctx context.Context) {
	go func() {
		timer := time.NewTimer(time.Until(nextUTCBackup()))
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				if _, e := s.Snapshot(context.Background(), defaultBackupKeep); e != nil {
					// Durable queue stays; the next UTC day retries.
				}
				timer.Reset(time.Until(nextUTCBackup()))
			}
		}
	}()
}

func nextUTCBackup() time.Time {
	now := time.Now().UTC()
	next := time.Date(now.Year(), now.Month(), now.Day()+1, 3, 0, 0, 0, time.UTC)
	return next
}
