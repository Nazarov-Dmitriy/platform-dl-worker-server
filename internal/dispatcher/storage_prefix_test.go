package dispatcher

import (
	"testing"
	"time"
)

func TestOwnedStoragePrefixIsValidatedAndBoundToAttempt(t *testing.T) {
	s, _, _ := openTest(t)
	req := testJob(t)
	req.ProcessingPrefix = "companies/company/courses/course/lessons/lesson/processing/"
	if _, _, _, err := s.validator.Request(encode(req)); err != nil {
		t.Fatal(err)
	}
	f := Fence{AssignmentID: UUID(), Generation: 2, DispatcherEpoch: UUID()}
	want := req.ProcessingPrefix + req.ID + "/" + f.DispatcherEpoch + "/2/" + f.AssignmentID + "/"
	if got := uploadPrefix(UUID(), req.ID, f, req); got != want {
		t.Fatalf("prefix: %s", got)
	}
	for _, bad := range []string{"jobs/", "companies/c/courses/x/../processing/", "companies/c/courses/x//processing/", "/absolute/"} {
		req.ProcessingPrefix = bad
		if _, _, _, err := s.validator.Request(encode(req)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestOwnedUploadGrantCannotEscapeItsDeclaredOwnerOrFence(t *testing.T) {
	req := testJob(t)
	req.ProcessingPrefix = "companies/company/channels/channel/posts/post/processing/"
	f := Fence{AssignmentID: UUID(), Generation: 1, DispatcherEpoch: UUID()}
	prefix := uploadPrefix("site", req.ID, f, req)
	grant := TransferGrant{Links: []Link{{Path: "index.m3u8", ObjectName: prefix + "index.m3u8", Method: "PUT",
		URL: "http://127.0.0.1:9/object", ExpiresAt: stamp(time.Now().Add(time.Hour)), Headers: map[string]string{}}}}
	if err := validateLinks(grant, []string{"index.m3u8"}, "PUT", "site", req.ID, f, "UPLOAD", req, true); err != nil {
		t.Fatal(err)
	}
	grant.Links[0].ObjectName = "jobs/site/" + req.ID + "/index.m3u8"
	if err := validateLinks(grant, []string{"index.m3u8"}, "PUT", "site", req.ID, f, "UPLOAD", req, true); err == nil {
		t.Fatal("accepted wrong storage owner")
	}
	grant.Links[0].ObjectName = prefix + "index.m3u8"
	f.Generation++
	if err := validateLinks(grant, []string{"index.m3u8"}, "PUT", "site", req.ID, f, "UPLOAD", req, true); err == nil {
		t.Fatal("accepted stale fence")
	}
}
