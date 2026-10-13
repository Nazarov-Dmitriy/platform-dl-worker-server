package dispatcher

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMaintenanceBlocksOffer(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 4)
	p, session := testDevice(t, s)
	submit(t, s, site)
	owner := AdminActor{ID: "o", Role: "OWNER"}
	if _, e := s.SetMaintenance(testContext, owner, true); e != nil {
		t.Fatal(e)
	}
	got, e := s.Offer(testContext, p, session)
	if e != nil {
		t.Fatal(e)
	}
	if got != nil {
		t.Fatal("maintenance must not offer work")
	}
	if _, e := s.SetMaintenance(testContext, owner, false); e != nil {
		t.Fatal(e)
	}
	offer(t, s, p, session)
}

func TestOperatorCannotSnapshot(t *testing.T) {
	s, _, _ := openTest(t)
	_, e := s.AdminSnapshot(testContext, AdminActor{ID: "op", Role: "OPERATOR"}, 7)
	var api *APIError
	if !errors.As(e, &api) || api.Status != 403 {
		t.Fatalf("got %v", e)
	}
}

func TestBackupRestoreRotatesEpoch(t *testing.T) {
	s, _, _ := openTest(t)
	old := s.Epoch()
	path, e := s.Snapshot(testContext, 7)
	if e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(path); e != nil {
		t.Fatal(e)
	}
	s.Close()
	target := filepath.Join(t.TempDir(), "restored.db")
	epoch, e := RestoreDatabase(target, path, DefaultConfig())
	if e != nil {
		t.Fatal(e)
	}
	if epoch == "" || epoch == old {
		t.Fatalf("restore must rotate epoch, old=%s new=%s", old, epoch)
	}
	reopened, e := Open(target, DefaultConfig())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if reopened.Epoch() != epoch {
		t.Fatal("restored epoch did not persist")
	}
	st, e := reopened.OpsStatus(testContext)
	if e != nil {
		t.Fatal(e)
	}
	if !st.Maintenance || st.RestoreGeneration < 1 {
		t.Fatalf("%+v", st)
	}
}
