package dispatcher

import (
	"testing"
	"time"
)

func TestPrivateHTTPStorageIsExplicitAndDoesNotAllowPublicOrMetadataHosts(t *testing.T) {
	for _, raw := range []string{"http://192.168.0.3:9000/file", "http://10.2.3.4/file", "http://172.20.0.2/file", "http://[fd00::1]/file"} {
		if checkLinkURL(Link{URL: raw}) == nil {
			t.Fatalf("private HTTP enabled by default: %s", raw)
		}
		if e := checkLinkURL(Link{URL: raw}, true); e != nil {
			t.Fatalf("explicit LAN endpoint rejected: %s %v", raw, e)
		}
	}
	for _, raw := range []string{"http://example.com/file", "http://8.8.8.8/file", "http://169.254.169.254/file", "http://private.example/file", "http://192.168.0.3.example/file"} {
		if checkLinkURL(Link{URL: raw}, true) == nil {
			t.Fatalf("unsafe HTTP endpoint allowed: %s", raw)
		}
	}
	c := DefaultConfig()
	if e := c.SetPrivateHTTPStorageSites("bad-site"); e == nil {
		t.Fatal("invalid site list accepted")
	}
}

func TestPrivateStorageGrantIsScopedToConfiguredSite(t *testing.T) {
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
	body := encode(TransferGrant{ProtocolVersion: "2.0", RequestID: requests[0].ID, Fence: o.Fence, Page: 0, LastPage: true,
		Links: []Link{{Path: "source", ObjectName: "uploads/video.mp4", URL: "http://192.168.0.3:9000/media/source", ExpiresAt: stamp(s.now().Add(time.Hour)), Method: "GET", Headers: map[string]string{}}}})
	if e = s.config.SetPrivateHTTPStorageSites(UUID()); e != nil {
		t.Fatal(e)
	}
	_, e = s.GrantTransfer(testContext, site.ID, o.JobID, body)
	wantError(t, e, "INVALID_REQUEST")
	if e = s.config.SetPrivateHTTPStorageSites(site.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.GrantTransfer(testContext, site.ID, o.JobID, body); e != nil {
		t.Fatal(e)
	}
	delivered, e := s.PendingGrants(testContext, p, session)
	if e != nil || len(delivered) != 1 {
		t.Fatalf("grant not delivered: %v", e)
	}
}
