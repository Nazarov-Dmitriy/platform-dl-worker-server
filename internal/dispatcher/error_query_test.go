package dispatcher

import (
	"strconv"
	"strings"
	"testing"
)

func TestErrorStoreListAndExport(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}
	for i := 0; i < 3; i++ {
		ev := testDiagEvent()
		ev.EventID = "event-000" + strconv.Itoa(i+1)
		ev.Code = "LIST"
		ev.Message = "case " + strconv.Itoa(i)
		if i == 2 {
			ev.Code = "OTHER"
		}
		recordDiag(t, s, sender, ev)
	}
	page, err := s.ListGroups(testContext, DiagnosticsQuery{Area: "sites", SiteID: "site-1", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	items := page["items"].([]map[string]any)
	if len(items) != 2 {
		t.Fatalf("groups = %d %#v", len(items), items)
	}
	sum := page["summary"].(map[string]any)
	if sum["groups"].(int) != 2 || sum["cases"].(int) != 3 {
		t.Fatalf("summary = %#v", sum)
	}
	id := items[0]["id"].(string)
	card, err := s.GroupCard(testContext, id, DiagnosticsQuery{Area: "sites"})
	if err != nil {
		t.Fatal(err)
	}
	if card["report"].(string) == "" || !strings.Contains(card["report"].(string), "Ошибка") {
		t.Fatalf("report = %v", card["report"])
	}
	rows, truncated, err := s.ExportEvents(testContext, DiagnosticsQuery{Area: "sites", SiteID: "site-1", Limit: 25})
	if err != nil || truncated || len(rows) != 3 {
		t.Fatalf("export %d truncated=%v err=%v", len(rows), truncated, err)
	}
}

func TestErrorStoreKeysetPage(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}
	for i := 0; i < 5; i++ {
		ev := testDiagEvent()
		ev.EventID = "event-p" + strconv.Itoa(i)
		ev.Code = "PAGE" + strconv.Itoa(i)
		recordDiag(t, s, sender, ev)
	}
	first, err := s.ListGroups(testContext, DiagnosticsQuery{Area: "sites", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	cur, _ := first["nextCursor"].(string)
	if cur == "" {
		t.Fatal("expected next cursor")
	}
	second, err := s.ListGroups(testContext, DiagnosticsQuery{Area: "sites", Limit: 2, Cursor: cur})
	if err != nil {
		t.Fatal(err)
	}
	a := first["items"].([]map[string]any)
	b := second["items"].([]map[string]any)
	if a[0]["id"] == b[0]["id"] {
		t.Fatal("pages overlapped")
	}
}

func TestErrorStoreFiltersReleaseAndSeverity(t *testing.T) {
	s, _ := openErrorsTest(t)
	sender := DiagnosticsSender{ID: "site-1", Area: "sites", SiteID: "site-1"}
	a := testDiagEvent()
	a.Code = "REL-A"
	a.Release = "keep"
	a.Severity = "error"
	recordDiag(t, s, sender, a)
	b := testDiagEvent()
	b.EventID = "event-0002"
	b.Code = "REL-B"
	b.Release = "other"
	b.Severity = "warning"
	recordDiag(t, s, sender, b)
	page, err := s.ListGroups(testContext, DiagnosticsQuery{Area: "sites", Release: "keep", Severity: "error", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	items := page["items"].([]map[string]any)
	if len(items) != 1 || items[0]["code"] != "REL-A" {
		t.Fatalf("filtered = %#v", items)
	}
}
