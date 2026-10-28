package dispatcher

import (
	"context"
	"path/filepath"
	"testing"
)

func TestDeviceAckSurvivesRestartAndIsAtomic(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AdmissionStable = 0
	path := filepath.Join(t.TempDir(), "dispatcher.db")
	s, e := Open(path, cfg)
	if e != nil {
		t.Fatal(e)
	}
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	job := submit(t, s, site)
	o := offer(t, s, p, session)
	if _, e = s.Accept(testContext, p, session, o.Fence, UUID()); e != nil {
		t.Fatal(e)
	}
	cause := APIError{Code: "TEST_EXECUTOR_ONLY", Message: "test", Permanent: true}
	id := UUID()
	record := deviceRecord{p, session, id, "fingerprint"}
	ctx := context.WithValue(testContext, deviceRecordKey{}, record)
	if e = s.Fail(ctx, p, session, o.Fence, cause, UUID()); e == nil {
		t.Fatal("wrong job accepted")
	}
	var count int
	s.db.QueryRow("SELECT count(*) FROM device_messages").Scan(&count)
	if count != 0 {
		t.Fatal("failed mutation acknowledged")
	}
	if e = s.Fail(ctx, p, session, o.Fence, cause, job.ID); e != nil {
		t.Fatal(e)
	}
	before, _ := s.Get(testContext, site.ID, job.ID)
	if e = s.Close(); e != nil {
		t.Fatal(e)
	}
	s, e = Open(path, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	session, e = s.Connect(testContext, p, testCaps(), testUsage(), nil)
	if e != nil {
		t.Fatal(e)
	}
	record.Session = session
	ctx = context.WithValue(testContext, deviceRecordKey{}, record)
	if e = s.Fail(ctx, p, session, o.Fence, cause, job.ID); e != nil {
		t.Fatal(e)
	}
	after, _ := s.Get(testContext, site.ID, job.ID)
	if after.Revision != before.Revision {
		t.Fatal("replay changed persisted result")
	}
}
func TestUpgradeStage2DatabasePreservesJobs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dispatcher.db")
	s, e := Open(path, DefaultConfig())
	if e != nil {
		t.Fatal(e)
	}
	site := testSite(t, s, 1)
	testDevice(t, s)
	job := submit(t, s, site)
	if _, e = s.db.Exec("DROP TABLE device_messages"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.db.Exec("DELETE FROM schema_migrations WHERE version=2"); e != nil {
		t.Fatal(e)
	}
	s.Close()
	s, e = Open(path, DefaultConfig())
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	v, e := s.Get(testContext, site.ID, job.ID)
	if e != nil || v.Status != "QUEUED" {
		t.Fatalf("migration lost job: %v", e)
	}
	var version int
	s.db.QueryRow("SELECT max(version) FROM schema_migrations").Scan(&version)
	if version != 8 {
		t.Fatal("migrations through 008 not applied")
	}
}
