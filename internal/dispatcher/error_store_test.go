package dispatcher

import (
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func openErrorsTest(t *testing.T) (*ErrorStore, *time.Time) {
	t.Helper()
	cfg := DefaultErrorJournalConfig()
	path := filepath.Join(t.TempDir(), "errors.sqlite")
	s, e := OpenErrors(path, cfg)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Date(2026, 11, 18, 10, 15, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	t.Cleanup(func() { _ = s.Close() })
	return s, &now
}

func testDiagEvent() DiagnosticsEvent {
	return DiagnosticsEvent{
		EventID:     "event-0001",
		OccurredAt:  "2026-11-18T10:15:30Z",
		Source:      "front",
		Service:     "web-app",
		Environment: "production",
		Release:     "2026.11.18",
		Severity:    "error",
		Code:        "HTTP_500",
		Module:      "checkout",
		Operation:   "cart.submit",
		Stage:       "submit",
		Message:     "Unhandled checkout failure",
		Cause:       "Payment provider timeout",
		Stack:       "TypeError: cannot read properties of undefined\n    at submit (checkout.js:12:3)",
		RequestID:   "req-0001",
		OperationID: "op-0001",
	}
}

func TestErrorStoreRecordsAndGroups(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}

	accepted, duplicates, err := s.Record(testContext, sender, []DiagnosticsEvent{testDiagEvent()})
	if err != nil {
		t.Fatal(err)
	}
	if accepted != 1 || duplicates != 0 {
		t.Fatalf("first delivery: accepted=%d duplicates=%d", accepted, duplicates)
	}

	// Same stable fields but different dynamic values (eventId, message,
	// release) must land in the same group.
	ev := testDiagEvent()
	ev.EventID = "event-0002"
	ev.Message = "Different dynamic message text"
	ev.Release = "2026.12.01"
	if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err != nil {
		t.Fatal(err)
	}

	var groups, occurrences int
	if err := s.db.QueryRow("SELECT count(*), coalesce(max(occurrences),0) FROM error_groups").Scan(&groups, &occurrences); err != nil {
		t.Fatal(err)
	}
	if groups != 1 {
		t.Fatalf("expected 1 group, got %d", groups)
	}
	if occurrences != 2 {
		t.Fatalf("expected 2 occurrences, got %d", occurrences)
	}
}

func TestErrorStoreRejectsInvalidBatch(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}

	ev := testDiagEvent()
	ev.Message = ""
	if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err == nil {
		t.Fatal("expected empty message to be rejected")
	}
	ev = testDiagEvent()
	ev.EventID = ""
	if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err == nil {
		t.Fatal("expected empty eventId to be rejected")
	}
	ev = testDiagEvent()
	ev.Source = "operator"
	if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err == nil {
		t.Fatal("expected unknown source to be rejected")
	}

	var events int
	if err := s.db.QueryRow("SELECT count(*) FROM error_events").Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 0 {
		t.Fatalf("expected no partial writes, found %d events", events)
	}
}

func TestErrorStoreDeduplicates(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}

	ev := testDiagEvent()
	if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err != nil {
		t.Fatal(err)
	}
	accepted, duplicates, err := s.Record(testContext, sender, []DiagnosticsEvent{ev})
	if err != nil {
		t.Fatal(err)
	}
	if accepted != 0 || duplicates != 1 {
		t.Fatalf("replay: accepted=%d duplicates=%d", accepted, duplicates)
	}
	var events, occurrences int
	if err := s.db.QueryRow("SELECT count(*) FROM error_events").Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT occurrences FROM error_groups LIMIT 1").Scan(&occurrences); err != nil {
		t.Fatal(err)
	}
	if events != 1 || occurrences != 1 {
		t.Fatalf("replay must not create a second case: events=%d occurrences=%d", events, occurrences)
	}
}

func TestErrorStoreQuotaAndStatus(t *testing.T) {
	s, _ := openErrorsTest(t)
	s.config.SenderHourlyLimit = 2
	s.config.GlobalHourlyLimit = 10
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}
	for i, id := range []string{"event-0001", "event-0002"} {
		ev := testDiagEvent()
		ev.EventID = id
		ev.Code = "C" + string(rune('A'+i))
		if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err != nil {
			t.Fatal(err)
		}
	}
	ev := testDiagEvent()
	ev.EventID = "event-0003"
	ev.Code = "CZ"
	_, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev})
	if err == nil {
		t.Fatal("expected quota rejection")
	}
	st, err := s.Status(testContext)
	if err != nil {
		t.Fatal(err)
	}
	if st.Events != 2 || st.LostQuota < 1 {
		t.Fatalf("status = %+v", st)
	}
	replay := testDiagEvent()
	accepted, dups, err := s.Record(testContext, sender, []DiagnosticsEvent{replay})
	if err != nil || accepted != 0 || dups != 1 {
		t.Fatalf("replay under quota: accepted=%d dups=%d err=%v", accepted, dups, err)
	}
	page, err := s.PageGroups(testContext, "sites", "site-1", 0, "", 10)
	if err != nil || len(page) != 2 {
		t.Fatalf("page = %v %v", page, err)
	}
}

func TestErrorStoreSanitizesBeforeWrite(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}
	ev := testDiagEvent()
	ev.Message = "fail Bearer abcdefghijklmnop"
	if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err != nil {
		t.Fatal(err)
	}
	var message string
	if err := s.db.QueryRow("SELECT message FROM error_events").Scan(&message); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(message, "abcdefghijklmnop") {
		t.Fatalf("stored secret: %s", message)
	}
}

func TestErrorStoreCheckpointAndPage(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}
	start := time.Now()
	for i := 0; i < 30; i++ {
		ev := testDiagEvent()
		ev.EventID = "event-" + strconv.Itoa(i)
		ev.Code = "C" + strconv.Itoa(i%3)
		if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Checkpoint(testContext); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("record+checkpoint took %s; measure before promising scheduler isolation", time.Since(start))
	}
	at, ok, err := s.LastReceived(testContext, "site-1")
	if err != nil || !ok || at.IsZero() {
		t.Fatalf("last received %v %v %v", at, ok, err)
	}
}

func TestDiagnosticsFingerprintStability(t *testing.T) {
	stackA := "TypeError: x is not a function\n    at render (app.js:12:3)"
	stackB := "TypeError: x is not a function\n    at render (app.js:99:10)"
	a := diagnosticsFingerprint("sites", "s", "front", "svc", "prod", "E", "m", "op", stackA)
	b := diagnosticsFingerprint("sites", "s", "front", "svc", "prod", "E", "m", "op", stackB)
	if a != b {
		t.Fatal("line numbers must not change the fingerprint")
	}
	c := diagnosticsFingerprint("sites", "s", "front", "svc", "prod", "OTHER", "m", "op", stackA)
	if a == c {
		t.Fatal("different code must change the fingerprint")
	}
	d := diagnosticsFingerprint("sites", "s", "back", "svc", "prod", "E", "m", "op", stackA)
	if a == d {
		t.Fatal("different source must change the fingerprint")
	}
}
