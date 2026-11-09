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

func TestChannelOwnerUploadPrefixFitsTransferPage(t *testing.T) {
	s, _, _ := openTest(t)
	req := testJob(t)
	req.ID = "197d8f8a-d01d-4f4f-8688-420c2e9324b5"
	req.ProcessingPrefix = "companies/osnovnaya-kompaniya/channels/e2e-acceptance-uuid-review-offerdeletion-1122be43/posts/novyj-vypusk-58872511/processing/"
	f := Fence{AssignmentID: "9e6b4de3-bcf2-412d-8518-57628bbcbf8b", Generation: 1,
		DispatcherEpoch: "34461a2c-71aa-4182-91ea-7791702f03ea"}
	prefix := uploadPrefix(UUID(), req.ID, f, req)
	if len(prefix) != 241 {
		t.Fatalf("fixture length %d", len(prefix))
	}
	art := testArtifact(t, f)
	page := map[string]any{
		"protocolVersion": "2.0",
		"requests": []TransferRequest{{
			ID: UUID(), Kind: "UPLOAD", Fence: f, UploadPrefix: prefix, Artifact: &art,
		}},
		"nextCursor": nil,
	}
	if err := s.validator.Check("TransferPage", encode(page)); err != nil {
		t.Fatal(err)
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
