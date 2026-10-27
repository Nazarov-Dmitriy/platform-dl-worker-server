package dispatcher

import "testing"

func TestSiteDeleteRevokesTokensAndPreservesHistory(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	_, _ = testDevice(t, s)
	job := submit(t, s, site)
	_, token, err := s.IssueToken(testContext, "SITE", site.ID)
	if err != nil {
		t.Fatal(err)
	}
	actor := AdminActor{ID: "owner", Role: "OWNER"}
	if err = s.AdminDeleteSite(testContext, actor, site.ID, `"1"`); err == nil {
		t.Fatal("deleted busy site")
	}
	if _, err = s.db.Exec("UPDATE jobs SET status='SUCCEEDED' WHERE site_id=?", site.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.AdminDeleteSite(testContext, AdminActor{Role: "OPERATOR"}, site.ID, `"1"`); err == nil {
		t.Fatal("unauthorized deletion")
	}
	if err = s.AdminDeleteSite(testContext, actor, site.ID, `"2"`); err == nil {
		t.Fatal("stale deletion")
	}
	if err = s.AdminDeleteSite(testContext, actor, site.ID, `"1"`); err != nil {
		t.Fatal(err)
	}
	sites, err := s.Sites(testContext)
	if err != nil || len(sites) != 0 {
		t.Fatalf("visible deleted site: %v %v", sites, err)
	}
	if _, err = s.Authenticate(testContext, token, "SITE"); err == nil {
		t.Fatal("token remains valid")
	}
	if _, _, err = s.IssueToken(testContext, "SITE", site.ID); err == nil {
		t.Fatal("token issued after deletion")
	}
	if err = s.SetSite(testContext, site.ID, true, 1); err == nil {
		t.Fatal("deleted site reenabled")
	}
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM jobs WHERE site_id=? AND id=?", site.ID, job.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("lost history", err)
	}
}
