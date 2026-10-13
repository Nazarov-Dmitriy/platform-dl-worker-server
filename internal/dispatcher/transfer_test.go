package dispatcher

import (
	"encoding/json"
	"testing"
	"time"
)

func runningOffer(t *testing.T, s *Store) (Site, Principal, string, *Offer) {
	t.Helper()
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	submit(t, s, site)
	o := offer(t, s, p, session)
	if _, e := s.Accept(testContext, p, session, o.Fence, UUID()); e != nil {
		t.Fatal(e)
	}
	return site, p, session, o
}
func testArtifact(t *testing.T, f Fence) Artifact {
	t.Helper()
	var msg struct {
		Body struct {
			Artifact Artifact `json:"artifact"`
		} `json:"body"`
	}
	if e := json.Unmarshal(readFixture(t, "valid/job-artifact-propose.json").Value, &msg); e != nil {
		t.Fatal(e)
	}
	art := msg.Body.Artifact
	art.Fence = f
	canonical, e := canonicalTransform(encode(art.Manifest))
	if e != nil {
		t.Fatal(e)
	}
	art.ManifestSHA256 = digest(canonical)
	return art
}
func grantSource(t *testing.T, s *Store, site Site, o *Offer, requestID string) {
	t.Helper()
	_, e := s.GrantTransfer(testContext, site.ID, o.JobID, encode(TransferGrant{
		ProtocolVersion: "2.0",
		RequestID:       requestID,
		Fence:           o.Fence,
		Links: []Link{{
			Path: "source", ObjectName: "uploads/video.mp4",
			URL: "http://127.0.0.1:9/source", ExpiresAt: stamp(s.now().Add(time.Hour)),
			Method: "GET", Headers: map[string]string{},
		}},
		Page: 0, LastPage: true,
	}))
	if e != nil {
		t.Fatal(e)
	}
}
func TestSourceDownloadAndPublicationPath(t *testing.T) {
	s, _, _ := openTest(t)
	site, p, session, o := runningOffer(t, s)
	if e := s.RequestSource(testContext, p, session, o.Fence, o.JobID); e != nil {
		t.Fatal(e)
	}
	page, e := s.ListTransfers(testContext, site.ID, o.JobID)
	if e != nil {
		t.Fatal(e)
	}
	requests := page["requests"].([]TransferRequest)
	if len(requests) != 1 || requests[0].Kind != "SOURCE" {
		t.Fatalf("%+v", page)
	}
	if e := s.RequestSource(testContext, p, session, o.Fence, o.JobID); e != nil {
		t.Fatal(e)
	}
	page2, _ := s.ListTransfers(testContext, site.ID, o.JobID)
	if page2["requests"].([]TransferRequest)[0].ID != requests[0].ID {
		t.Fatal("source request was not reused")
	}
	grantSource(t, s, site, o, requests[0].ID)
	art := testArtifact(t, o.Fence)
	if e := s.ProposeArtifact(testContext, p, session, o.Fence, o.JobID, art); e != nil {
		t.Fatal(e)
	}
	if e := s.ProposeArtifact(testContext, p, session, o.Fence, o.JobID, art); e != nil {
		t.Fatal(e)
	}
	other := art
	other.ID = UUID()
	if e := s.ProposeArtifact(testContext, p, session, o.Fence, o.JobID, other); e == nil {
		t.Fatal("conflicting artifact accepted")
	} else {
		wantError(t, e, "ARTIFACT_CONFLICT")
	}
	uploads, e := s.ListTransfers(testContext, site.ID, o.JobID)
	if e != nil {
		t.Fatal(e)
	}
	up := uploads["requests"].([]TransferRequest)[0]
	if up.Kind != "UPLOAD" || up.Artifact == nil {
		t.Fatal(up)
	}
	links := make([]Link, 0, len(art.Manifest.Files))
	prefix := "jobs/" + site.ID + "/" + o.JobID + "/" + o.Fence.DispatcherEpoch + "/" + formatGeneration(o.Fence.Generation) + "/" + o.Fence.AssignmentID + "/"
	for _, file := range art.Manifest.Files {
		links = append(links, Link{
			Path: file.Path, ObjectName: prefix + file.Path,
			URL: "http://127.0.0.1:9/" + file.Path, ExpiresAt: stamp(s.now().Add(time.Hour)),
			Method: "PUT", Headers: map[string]string{"Content-Type": file.ContentType},
		})
	}
	if _, e := s.GrantTransfer(testContext, site.ID, o.JobID, encode(TransferGrant{ProtocolVersion: "2.0", RequestID: up.ID, Fence: o.Fence, Links: links, Page: 0, LastPage: true})); e != nil {
		t.Fatal(e)
	}
	if e := s.CompleteUpload(testContext, p, session, o.Fence, o.JobID, art.ID, art.ManifestSHA256); e != nil {
		t.Fatal(e)
	}
	if e := s.CompleteUpload(testContext, p, session, o.Fence, o.JobID, art.ID, art.ManifestSHA256); e != nil {
		t.Fatal(e)
	}
	view, e := s.Get(testContext, site.ID, o.JobID)
	if e != nil || view.Status != "AWAITING_PUBLICATION" || view.Artifact == nil || !view.Actionable {
		t.Fatalf("%+v %v", view, e)
	}
	if e := s.validator.Check("JobView", encode(view)); e != nil {
		t.Fatal(e)
	}
	late := s.Fail(testContext, p, session, o.Fence, APIError{Code: "LATE", Message: "late", Permanent: true}, o.JobID)
	wantError(t, late, "STALE_ASSIGNMENT")
	claimRaw := encode(map[string]any{"protocolVersion": "2.0", "claimId": UUID(), "artifactId": art.ID, "manifestSha256": art.ManifestSHA256, "fence": o.Fence})
	claim, e := s.ClaimPublication(testContext, site.ID, o.JobID, claimRaw)
	if e != nil || claim.ArtifactID != art.ID {
		t.Fatal(e, claim)
	}
	again, e := s.ClaimPublication(testContext, site.ID, o.JobID, claimRaw)
	if e != nil || again.ClaimID != claim.ClaimID {
		t.Fatal(e, again)
	}
	raw := encode(map[string]string{"protocolVersion": "2.0", "requestId": UUID(), "reason": "too late"})
	_, e = s.Control(testContext, site.ID, o.JobID, "release", raw)
	wantError(t, e, "PUBLICATION_IN_PROGRESS")
	dec := encode(map[string]any{"protocolVersion": "2.0", "artifactId": art.ID, "fence": o.Fence, "manifestSha256": art.ManifestSHA256, "decision": "PUBLISHED", "publicationId": UUID(), "claimId": claim.ClaimID})
	ack, _, e := s.DecidePublication(testContext, site.ID, o.JobID, dec)
	if e != nil || ack["applied"] != true {
		t.Fatal(e, ack)
	}
	if _, _, e := s.DecidePublication(testContext, site.ID, o.JobID, dec); e != nil {
		t.Fatal(e)
	}
	done, e := s.Get(testContext, site.ID, o.JobID)
	if e != nil || done.Status != "PARTIAL" || !done.ManualEntryOffered {
		t.Fatalf("%+v %v", done, e)
	}
}
func TestGrantRejectsForeignPrefixAndIncompletePages(t *testing.T) {
	s, _, _ := openTest(t)
	site, p, session, o := runningOffer(t, s)
	if e := s.RequestSource(testContext, p, session, o.Fence, o.JobID); e != nil {
		t.Fatal(e)
	}
	page, _ := s.ListTransfers(testContext, site.ID, o.JobID)
	id := page["requests"].([]TransferRequest)[0].ID
	_, e := s.GrantTransfer(testContext, site.ID, o.JobID, encode(TransferGrant{
		ProtocolVersion: "2.0", RequestID: id, Fence: o.Fence,
		Links: []Link{{Path: "source", ObjectName: "other.mp4", URL: "http://127.0.0.1:9/x", ExpiresAt: stamp(s.now().Add(time.Hour)), Method: "GET", Headers: map[string]string{}}},
		Page:  0, LastPage: true,
	}))
	wantError(t, e, "INVALID_REQUEST")
	_, e = s.GrantTransfer(testContext, site.ID, o.JobID, encode(TransferGrant{
		ProtocolVersion: "2.0", RequestID: id, Fence: o.Fence,
		Links: []Link{{Path: "source", ObjectName: "uploads/video.mp4", URL: "http://example.invalid/x", ExpiresAt: stamp(s.now().Add(time.Hour)), Method: "GET", Headers: map[string]string{}}},
		Page:  0, LastPage: true,
	}))
	wantError(t, e, "INVALID_REQUEST")
	grantSource(t, s, site, o, id)
	art := testArtifact(t, o.Fence)
	if e := s.ProposeArtifact(testContext, p, session, o.Fence, o.JobID, art); e != nil {
		t.Fatal(e)
	}
	up, _ := s.ListTransfers(testContext, site.ID, o.JobID)
	uid := up["requests"].([]TransferRequest)[0].ID
	_, e = s.GrantTransfer(testContext, site.ID, o.JobID, encode(TransferGrant{
		ProtocolVersion: "2.0", RequestID: uid, Fence: o.Fence,
		Links: []Link{{Path: art.Manifest.Files[0].Path, ObjectName: "jobs/other/file", URL: "http://127.0.0.1:9/x", ExpiresAt: stamp(s.now().Add(time.Hour)), Method: "PUT", Headers: map[string]string{}}},
		Page:  0, LastPage: true,
	}))
	wantError(t, e, "INVALID_REQUEST")
	if e := s.CompleteUpload(testContext, p, session, o.Fence, o.JobID, art.ID, art.ManifestSHA256); e == nil {
		t.Fatal("complete without grant")
	} else {
		wantError(t, e, "INCOMPLETE_GRANT")
	}
}
func TestReleaseAfterUploadDoesNotStartLocalDuplicateRight(t *testing.T) {
	s, _, _ := openTest(t)
	site, p, session, o := runningOffer(t, s)
	if e := s.RequestSource(testContext, p, session, o.Fence, o.JobID); e != nil {
		t.Fatal(e)
	}
	page, _ := s.ListTransfers(testContext, site.ID, o.JobID)
	grantSource(t, s, site, o, page["requests"].([]TransferRequest)[0].ID)
	art := testArtifact(t, o.Fence)
	if e := s.ProposeArtifact(testContext, p, session, o.Fence, o.JobID, art); e != nil {
		t.Fatal(e)
	}
	up, _ := s.ListTransfers(testContext, site.ID, o.JobID)
	uid := up["requests"].([]TransferRequest)[0].ID
	prefix := "jobs/" + site.ID + "/" + o.JobID + "/" + o.Fence.DispatcherEpoch + "/" + formatGeneration(o.Fence.Generation) + "/" + o.Fence.AssignmentID + "/"
	links := []Link{}
	for _, file := range art.Manifest.Files {
		links = append(links, Link{Path: file.Path, ObjectName: prefix + file.Path, URL: "http://127.0.0.1:9/" + file.Path, ExpiresAt: stamp(s.now().Add(time.Hour)), Method: "PUT", Headers: map[string]string{}})
	}
	if _, e := s.GrantTransfer(testContext, site.ID, o.JobID, encode(TransferGrant{ProtocolVersion: "2.0", RequestID: uid, Fence: o.Fence, Links: links, Page: 0, LastPage: true})); e != nil {
		t.Fatal(e)
	}
	if e := s.CompleteUpload(testContext, p, session, o.Fence, o.JobID, art.ID, art.ManifestSHA256); e != nil {
		t.Fatal(e)
	}
	v, e := s.Control(testContext, site.ID, o.JobID, "release", encode(map[string]string{"protocolVersion": "2.0", "requestId": UUID(), "reason": "fallback"}))
	if e != nil || v.Status != "RELEASED" || v.ReleaseReceipt == nil || !v.ReleaseReceipt.SafeToRunLocally {
		t.Fatalf("%+v %v", v, e)
	}
	if _, e := s.Offer(testContext, p, session); e != nil {
		t.Fatal(e)
	}
}
func TestRejectedPublicationFailsWithoutRequeue(t *testing.T) {
	s, _, _ := openTest(t)
	site, p, session, o := runningOffer(t, s)
	if e := s.RequestSource(testContext, p, session, o.Fence, o.JobID); e != nil {
		t.Fatal(e)
	}
	page, _ := s.ListTransfers(testContext, site.ID, o.JobID)
	grantSource(t, s, site, o, page["requests"].([]TransferRequest)[0].ID)
	art := testArtifact(t, o.Fence)
	if e := s.ProposeArtifact(testContext, p, session, o.Fence, o.JobID, art); e != nil {
		t.Fatal(e)
	}
	up, _ := s.ListTransfers(testContext, site.ID, o.JobID)
	uid := up["requests"].([]TransferRequest)[0].ID
	prefix := "jobs/" + site.ID + "/" + o.JobID + "/" + o.Fence.DispatcherEpoch + "/" + formatGeneration(o.Fence.Generation) + "/" + o.Fence.AssignmentID + "/"
	links := []Link{}
	for _, file := range art.Manifest.Files {
		links = append(links, Link{Path: file.Path, ObjectName: prefix + file.Path, URL: "http://127.0.0.1:9/x", ExpiresAt: stamp(s.now().Add(time.Hour)), Method: "PUT", Headers: map[string]string{}})
	}
	if _, e := s.GrantTransfer(testContext, site.ID, o.JobID, encode(TransferGrant{ProtocolVersion: "2.0", RequestID: uid, Fence: o.Fence, Links: links, Page: 0, LastPage: true})); e != nil {
		t.Fatal(e)
	}
	if e := s.CompleteUpload(testContext, p, session, o.Fence, o.JobID, art.ID, art.ManifestSHA256); e != nil {
		t.Fatal(e)
	}
	claim, e := s.ClaimPublication(testContext, site.ID, o.JobID, encode(map[string]any{"protocolVersion": "2.0", "claimId": UUID(), "artifactId": art.ID, "manifestSha256": art.ManifestSHA256, "fence": o.Fence}))
	if e != nil {
		t.Fatal(e)
	}
	_, _, e = s.DecidePublication(testContext, site.ID, o.JobID, encode(map[string]any{"protocolVersion": "2.0", "artifactId": art.ID, "fence": o.Fence, "manifestSha256": art.ManifestSHA256, "decision": "REJECTED", "claimId": claim.ClaimID, "error": map[string]any{"code": "MANIFEST_INVALID", "message": "playlist missing", "permanent": true}}))
	if e != nil {
		t.Fatal(e)
	}
	view, e := s.Get(testContext, site.ID, o.JobID)
	if e != nil || view.Status != "FAILED" {
		t.Fatalf("%+v %v", view, e)
	}
}
