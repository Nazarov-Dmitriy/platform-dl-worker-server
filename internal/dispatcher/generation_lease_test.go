package dispatcher

import (
	"testing"
	"time"
)

// A long generation must keep its assignment when displayed progress stops changing.
func TestGeneratingLeaseRenewalAndCancellation(t *testing.T) {
	s, now, _ := openTest(t)
	site, err := s.CreateSite(testContext, "generation-lease", 1, []string{"media.generate"})
	if err != nil {
		t.Fatal(err)
	}
	device, session := testDevice(t, s)
	model := generationTestModel("selected")
	if err = s.Heartbeat(testContext, device, session, generationTestCaps(model), testUsage()); err != nil {
		t.Fatal(err)
	}
	job := generationTestJob(model)
	job.MaxDurationSeconds = 600
	if _, _, err = s.Submit(testContext, site.ID, encode(job)); err != nil {
		t.Fatal(err)
	}
	assigned := offer(t, s, device, session)
	if _, err = s.Accept(testContext, device, session, assigned.Fence, UUID()); err != nil {
		t.Fatal(err)
	}
	progress := 0.793
	update := StatusUpdate{Stage: "GENERATING", ActivitySequence: 1, Progress: &progress}
	for range 3 {
		*now = now.Add(60 * time.Second)
		if err = s.Heartbeat(testContext, device, session, generationTestCaps(model), testUsage()); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Renew(testContext, device, session, assigned.Fence, UUID(), update); err != nil {
			t.Fatalf("generation lease rejected: %v", err)
		}
		if err = s.Expire(testContext); err != nil {
			t.Fatal(err)
		}
		view, err := s.Get(testContext, site.ID, job.ID)
		if err != nil || view.Status != "RUNNING" || view.Stage != "GENERATING" {
			t.Fatalf("generation lost its assignment: %+v %v", view, err)
		}
	}
	raw := encode(map[string]string{"protocolVersion": "2.0", "requestId": UUID(), "reason": "USER_CANCEL"})
	view, err := s.Control(testContext, site.ID, job.ID, "cancel", raw)
	if err != nil || view.Status != "CANCELLING" {
		t.Fatalf("cancel was not accepted: %+v %v", view, err)
	}
	_, err = s.Renew(testContext, device, session, assigned.Fence, UUID(), update)
	wantError(t, err, "STOP_REQUIRED")
	if err = s.Stopped(testContext, device, session, assigned.Fence, job.ID); err != nil {
		t.Fatal(err)
	}
	view, err = s.Get(testContext, site.ID, job.ID)
	if err != nil || view.Status != "CANCELLED" {
		t.Fatalf("cancel did not complete: %+v %v", view, err)
	}
}
