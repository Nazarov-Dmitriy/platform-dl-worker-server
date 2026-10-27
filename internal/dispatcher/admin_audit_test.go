package dispatcher

import (
	"testing"
	"time"
)

func TestAuditPaginationFiltersAndOrder(t *testing.T) {
	s, _, _ := openTest(t)
	if _, e := s.db.Exec("DELETE FROM audit"); e != nil {
		t.Fatal(e)
	}
	base := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 25; i++ {
		kind := "DEVICE_CONNECTED"
		if i%3 == 0 {
			kind = "JOB_FAILED"
		}
		principal := "one"
		if i%2 != 0 {
			principal = "two"
		}
		if _, e := s.db.Exec("INSERT INTO audit(at,kind,principal_id,job_id) VALUES(?,?,?,?)", base.Add(time.Duration(i)*time.Second).UnixMilli(), kind, principal, "job"); e != nil {
			t.Fatal(e)
		}
	}
	first, e := s.AuditPage(testContext, AuditFilter{Limit: 20})
	if e != nil {
		t.Fatal(e)
	}
	if len(first.Items) != 20 || first.NextCursor == nil {
		t.Fatalf("bad first page: %+v", first)
	}
	if first.Items[0]["at"] != stamp(base.Add(24*time.Second)) {
		t.Fatal("newest row is not first")
	}
	second, e := s.AuditPage(testContext, AuditFilter{Limit: 20, Cursor: *first.NextCursor})
	if e != nil || len(second.Items) != 5 || second.NextCursor != nil {
		t.Fatalf("bad second page: %+v %v", second, e)
	}
	filtered, e := s.AuditPage(testContext, AuditFilter{Limit: 20, ErrorsOnly: true, Principal: "one", Job: "job", From: base.Add(5 * time.Second), To: base.Add(12 * time.Second)})
	if e != nil || len(filtered.Items) != 2 {
		t.Fatalf("filters: %+v %v", filtered, e)
	}
	_, e = s.AuditPage(testContext, AuditFilter{Limit: 101})
	wantError(t, e, "INVALID_PAGE")
}
func TestAuditFailureDetailsAndRecentJobs(t *testing.T) {
	s, _, _ := openTest(t)
	site, p, session, o := runningOffer(t, s)
	if e := s.Fail(testContext, p, session, o.Fence, APIError{Code: "WAIT_TIMEOUT", Message: "Timed out", Permanent: true}, o.JobID); e != nil {
		t.Fatal(e)
	}
	page, e := s.AuditPage(testContext, AuditFilter{Limit: 20, Job: o.JobID, ErrorsOnly: true})
	if e != nil {
		t.Fatal(e)
	}
	if len(page.Items) != 1 {
		t.Fatalf("failure row missing: %+v", page)
	}
	detail, ok := page.Items[0]["error"].(*APIError)
	if !ok || detail.Code != "WAIT_TIMEOUT" {
		t.Fatalf("failure details: %+v", page.Items[0])
	}
	ids := []string{}
	for i := 0; i < 12; i++ {
		ids = append(ids, submit(t, s, site).ID)
	}
	recent, e := s.RecentAdminJobs(testContext, site.ID, 10)
	if e != nil {
		t.Fatal(e)
	}
	jobs := recent["jobs"].([]JobView)
	if len(jobs) != 10 || jobs[0].ID != ids[11] || jobs[9].ID != ids[2] {
		t.Fatal("recent jobs are not capped/newest first")
	}
}
