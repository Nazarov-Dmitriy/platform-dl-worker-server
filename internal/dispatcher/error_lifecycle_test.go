package dispatcher

import (
	"testing"
	"time"
)

func recordDiag(t *testing.T, s *ErrorStore, sender DiagnosticsSender, ev DiagnosticsEvent) {
	t.Helper()
	if _, _, err := s.Record(testContext, sender, []DiagnosticsEvent{ev}); err != nil {
		t.Fatal(err)
	}
}

func groupIDByCode(t *testing.T, s *ErrorStore, code string) string {
	t.Helper()
	var id string
	if err := s.db.QueryRow("SELECT id FROM error_groups WHERE code=?", code).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func eventSeqOf(t *testing.T, s *ErrorStore, groupID string) int64 {
	t.Helper()
	var seq int64
	if err := s.db.QueryRow("SELECT seq FROM error_events WHERE group_id=? ORDER BY seq LIMIT 1", groupID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return seq
}

func TestErrorStorePruneHonorsProtection(t *testing.T) {
	s, now := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}

	a := testDiagEvent()
	a.Code = "PROTECTED"
	recordDiag(t, s, sender, a)
	groupA := groupIDByCode(t, s, "PROTECTED")
	if err := s.SetFavorite(testContext, groupA, true, "owner"); err != nil {
		t.Fatal(err)
	}
	if err := s.PinExample(testContext, groupA, eventSeqOf(t, s, groupA), "owner"); err != nil {
		t.Fatal(err)
	}

	b := testDiagEvent()
	b.EventID = "event-0002"
	b.Code = "EXPIRING"
	recordDiag(t, s, sender, b)

	*now = now.Add(15 * 24 * time.Hour)
	if err := s.Prune(testContext); err != nil {
		t.Fatal(err)
	}

	var protected, expiring int
	if err := s.db.QueryRow("SELECT count(*) FROM error_events e JOIN error_groups g ON g.id=e.group_id WHERE g.code='PROTECTED'").Scan(&protected); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT count(*) FROM error_groups WHERE code='EXPIRING'").Scan(&expiring); err != nil {
		t.Fatal(err)
	}
	if protected != 1 {
		t.Fatalf("pinned example of favorite group must survive TTL, got %d", protected)
	}
	if expiring != 0 {
		t.Fatalf("unprotected expired group must be pruned, got %d", expiring)
	}
}

func TestErrorStoreResolvedReactivatesOnNewCase(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}

	ev := testDiagEvent()
	ev.Code = "BUG-1"
	recordDiag(t, s, sender, ev)
	group := groupIDByCode(t, s, "BUG-1")
	if err := s.SetStatus(testContext, group, "RESOLVED", "owner"); err != nil {
		t.Fatal(err)
	}

	// A new case with a different release reactivates the resolved group.
	again := testDiagEvent()
	again.EventID = "event-0002"
	again.Code = "BUG-1"
	again.Release = "2026.12.01"
	recordDiag(t, s, sender, again)

	var status string
	if err := s.db.QueryRow("SELECT status FROM error_groups WHERE id=?", group).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "NEW" {
		t.Fatalf("resolved group must reactivate to NEW, got %s", status)
	}
	var history int
	if err := s.db.QueryRow("SELECT count(*) FROM error_history WHERE group_id=?", group).Scan(&history); err != nil {
		t.Fatal(err)
	}
	if history != 2 {
		t.Fatalf("expected 2 history entries (resolve + reactivate), got %d", history)
	}
}

func TestErrorStoreNoteAndIgnoredStaysIgnored(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}

	ev := testDiagEvent()
	ev.Code = "BUG-2"
	recordDiag(t, s, sender, ev)
	group := groupIDByCode(t, s, "BUG-2")
	if err := s.SetStatus(testContext, group, "IGNORED", "owner"); err != nil {
		t.Fatal(err)
	}
	if err := s.AddNote(testContext, group, "owner", "Revisit after the next release"); err != nil {
		t.Fatal(err)
	}

	again := testDiagEvent()
	again.EventID = "event-0002"
	again.Code = "BUG-2"
	recordDiag(t, s, sender, again)

	var status string
	if err := s.db.QueryRow("SELECT status FROM error_groups WHERE id=?", group).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "IGNORED" {
		t.Fatalf("ignored group must keep its status, got %s", status)
	}
	var notes int
	if err := s.db.QueryRow("SELECT count(*) FROM error_notes WHERE group_id=?", group).Scan(&notes); err != nil {
		t.Fatal(err)
	}
	if notes != 1 {
		t.Fatalf("expected 1 note, got %d", notes)
	}
}
