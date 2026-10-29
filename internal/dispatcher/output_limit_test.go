package dispatcher

import "testing"

func TestZeroOutputLimitIsAcceptedAndNegativeIsRejected(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	testDevice(t, s)
	j := testJob(t)
	j.MaxOutputBytes = 0
	v, created, err := s.Submit(testContext, site.ID, encode(j))
	if err != nil || !created || v.Status != "QUEUED" {
		t.Fatalf("zero output limit: created=%v status=%s error=%v", created, v.Status, err)
	}
	j.ID = UUID()
	j.MaxOutputBytes = -1
	if _, _, err := s.Submit(testContext, site.ID, encode(j)); err == nil {
		t.Fatal("negative output limit must be rejected")
	}
}
