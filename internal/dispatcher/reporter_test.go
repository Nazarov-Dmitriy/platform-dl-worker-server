package dispatcher

import (
	"path/filepath"
	"testing"
)

func TestReporterFallbackDoesNotRecurse(t *testing.T) {
	s, _ := openErrorsTest(t)
	path := filepath.Join(t.TempDir(), "errors-fallback.jsonl")
	r := NewReporter(s, path, "dispatcher")
	_ = s.Close()
	r.Report(testContext, DiagnosticsEvent{Code: "SINK_DOWN", Message: "cannot write journal"})
	if r.FallbackCount() != 1 {
		t.Fatalf("fallback count = %d", r.FallbackCount())
	}
	r.Report(testContext, DiagnosticsEvent{Code: "SINK_DOWN", Message: "cannot write journal again"})
	if r.FallbackCount() < 1 || r.FallbackCount() > maxFallbackLines {
		t.Fatalf("fallback grew unbounded: %d", r.FallbackCount())
	}
}

func TestReporterWritesWorkerEvents(t *testing.T) {
	s, _ := openErrorsTest(t)
	r := NewReporter(s, filepath.Join(t.TempDir(), "errors-fallback.jsonl"), "dispatcher")
	r.ReportCode(testContext, "SCHEDULER_EXPIRE", "Lease expiry failed", "scheduler", "")
	var area, source, code string
	if err := s.db.QueryRow("SELECT area,source,code FROM error_events").Scan(&area, &source, &code); err != nil {
		t.Fatal(err)
	}
	if area != "worker" || source != "worker" || code != "SCHEDULER_EXPIRE" {
		t.Fatalf("stored %s %s %s", area, source, code)
	}
	if r.FallbackCount() != 0 {
		t.Fatal("successful report used fallback")
	}
}
