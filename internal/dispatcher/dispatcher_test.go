package dispatcher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var testContext = context.Background()

type fixture struct {
	Schema string          `json:"schema"`
	Value  json.RawMessage `json:"value"`
}

func readFixture(t testing.TB, name string) fixture {
	t.Helper()
	raw, e := os.ReadFile(filepath.Join("..", "..", "contracts", "fixtures", name))
	if e != nil {
		t.Fatal(e)
	}
	var f fixture
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	return f
}
func testJob(t testing.TB) JobRequest {
	t.Helper()
	var j JobRequest
	if e := json.Unmarshal(readFixture(t, "valid/job-video.json").Value, &j); e != nil {
		t.Fatal(e)
	}
	j.ID = UUID()
	return j
}
func testCaps() []Capability {
	return []Capability{{Code: "media.transcode", RecognitionLanguages: []string{}, TranslationDirections: []Pair{}, AutoDetect: false, Formats: []string{"hls"}, Availability: "ONLINE", ProfilePolicies: []string{"X264_EXACT"}}}
}
func testUsage() Usage {
	return Usage{CPUPercent: 10, MemoryUsedPercent: 20, MemoryPressure: "NORMAL", DiskUsedPercent: 10, FreeMemoryBytes: 8 << 30, FreeDiskBytes: 100 << 30, AvailableSlots: 1, WorkDiskAvailable: true}
}
func openTest(t testing.TB) (*Store, *time.Time, string) {
	t.Helper()
	cfg := DefaultConfig()
	cfg.AdmissionStable = 0
	path := filepath.Join(t.TempDir(), "dispatcher.db")
	s, e := Open(path, cfg)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	t.Cleanup(func() { _ = s.Close() })
	return s, &now, path
}
func testSite(t testing.TB, s *Store, weight int) Site {
	t.Helper()
	v, e := s.CreateSite(testContext, "test", weight, []string{"media.transcode", "media.transcribe", "media.subtitles"})
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func testDevice(t testing.TB, s *Store) (Principal, string) {
	t.Helper()
	d, e := s.CreateDevice(testContext, "test device", testCaps())
	if e != nil {
		t.Fatal(e)
	}
	_, token, e := s.IssueToken(testContext, "DEVICE", d.ID)
	if e != nil {
		t.Fatal(e)
	}
	p, e := s.Authenticate(testContext, token, "DEVICE")
	if e != nil {
		t.Fatal(e)
	}
	session, e := s.Connect(testContext, p, testCaps(), testUsage(), nil)
	if e != nil {
		t.Fatal(e)
	}
	return p, session
}
func submit(t testing.TB, s *Store, site Site) JobRequest {
	t.Helper()
	j := testJob(t)
	v, new, e := s.Submit(testContext, site.ID, encode(j))
	if e != nil || !new || v.Status != "QUEUED" {
		t.Fatalf("submit: %v new=%v status=%s", e, new, v.Status)
	}
	return j
}
func offer(t testing.TB, s *Store, p Principal, session string) *Offer {
	t.Helper()
	v, e := s.Offer(testContext, p, session)
	if e != nil || v == nil {
		t.Fatalf("offer: %v %+v", e, v)
	}
	return v
}
func wantError(t testing.TB, e error, code string) {
	t.Helper()
	var api *APIError
	if !errors.As(e, &api) || api.Code != code {
		t.Fatalf("wanted %s, got %v", code, e)
	}
}

func TestSchemaFixturesAndCanonicalRequests(t *testing.T) {
	s, _, _ := openTest(t)
	for _, dir := range []string{"valid", "invalid"} {
		files, e := filepath.Glob(filepath.Join("..", "..", "contracts", "fixtures", dir, "*.json"))
		if e != nil {
			t.Fatal(e)
		}
		for _, p := range files {
			f := readFixture(t, filepath.Join(dir, filepath.Base(p)))
			if _, ok := s.validator.schemas[f.Schema]; !ok {
				continue
			}
			e := s.validator.Check(f.Schema, f.Value)
			if dir == "valid" && e != nil {
				t.Fatalf("%s: %v", p, e)
			}
			if dir == "invalid" && e == nil {
				t.Fatalf("accepted invalid fixture %s", p)
			}
		}
	}
	j := testJob(t)
	raw := encode(j)
	pretty, e := json.MarshalIndent(j, "", " ")
	if e != nil {
		t.Fatal(e)
	}
	_, _, a, e := s.validator.Request(raw)
	if e != nil {
		t.Fatal(e)
	}
	_, _, b, e := s.validator.Request(pretty)
	if e != nil || a != b {
		t.Fatal("formatting changed identity", e)
	}
	dup := bytes.Replace(raw, []byte(`"protocolVersion":"2.0"`), []byte(`"protocolVersion":"2.0","protocolVersion":"2.0"`), 1)
	_, _, _, e = s.validator.Request(dup)
	wantError(t, e, "INVALID_REQUEST")
}

func TestConcurrentSubmitAndAtomicAssignment(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	p1, session1 := testDevice(t, s)
	p2, session2 := testDevice(t, s)
	j := testJob(t)
	var created atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			_, new, e := s.Submit(testContext, site.ID, encode(j))
			if e != nil {
				t.Error(e)
			}
			if new {
				created.Add(1)
			}
		})
	}
	wg.Wait()
	if created.Load() != 1 {
		t.Fatalf("created %d copies", created.Load())
	}
	var assigned atomic.Int32
	for _, d := range []struct {
		p       Principal
		session string
	}{{p1, session1}, {p2, session2}} {
		wg.Go(func() {
			v, e := s.Offer(testContext, d.p, d.session)
			if e != nil {
				t.Error(e)
			}
			if v != nil {
				assigned.Add(1)
			}
		})
	}
	wg.Wait()
	if assigned.Load() != 1 {
		t.Fatalf("assigned %d times", assigned.Load())
	}
	j.MaxOutputBytes++
	_, _, e := s.Submit(testContext, site.ID, encode(j))
	wantError(t, e, "IDEMPOTENCY_CONFLICT")
}

func TestLeaseExpiryReplayAndForeignDevice(t *testing.T) {
	s, now, _ := openTest(t)
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	other, otherSession := testDevice(t, s)
	submit(t, s, site)
	o := offer(t, s, p, session)
	rid := UUID()
	first, e := s.Accept(testContext, p, session, o.Fence, rid)
	if e != nil {
		t.Fatal(e)
	}
	*now = now.Add(time.Second)
	replay, e := s.Accept(testContext, p, session, o.Fence, rid)
	if e != nil || first.ExpiresAt != replay.ExpiresAt {
		t.Fatal("accept replay extended lease", e)
	}
	_, e = s.Accept(testContext, other, otherSession, o.Fence, UUID())
	wantError(t, e, "STALE_ASSIGNMENT")
	u := StatusUpdate{Stage: "TRANSCODING", ActivitySequence: 1, Steps: []Step{{Name: "video", Status: "RUNNING"}}}
	renewID := UUID()
	renew, e := s.Renew(testContext, p, session, o.Fence, renewID, u)
	if e != nil {
		t.Fatal(e)
	}
	*now = now.Add(time.Second)
	again, e := s.Renew(testContext, p, session, o.Fence, renewID, u)
	if e != nil || again.ExpiresAt != renew.ExpiresAt {
		t.Fatal("renew replay extended lease", e)
	}
	u.ActivitySequence++
	_, e = s.Renew(testContext, p, session, o.Fence, renewID, u)
	wantError(t, e, "IDEMPOTENCY_CONFLICT")
	*now = now.Add(121 * time.Second)
	_, e = s.Renew(testContext, p, session, o.Fence, UUID(), u)
	wantError(t, e, "LEASE_EXPIRED")
	if e = s.Expire(testContext); e != nil {
		t.Fatal(e)
	}
	if e = s.Heartbeat(testContext, other, otherSession, testCaps(), testUsage()); e != nil {
		t.Fatal(e)
	}
	newOffer := offer(t, s, other, otherSession)
	if newOffer.Fence.AssignmentID == o.Fence.AssignmentID || newOffer.Fence.Generation != 2 {
		t.Fatal("generation was reused")
	}
	_, e = s.Accept(testContext, p, session, o.Fence, rid)
	wantError(t, e, "STALE_ASSIGNMENT")
}

func TestOfferExpiryDoesNotSpendExecutionBudget(t *testing.T) {
	s, now, _ := openTest(t)
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	submit(t, s, site)
	for range 5 {
		o := offer(t, s, p, session)
		*now = now.Add(11 * time.Second)
		_, e := s.Accept(testContext, p, session, o.Fence, UUID())
		wantError(t, e, "LEASE_EXPIRED")
		if e = s.Expire(testContext); e != nil {
			t.Fatal(e)
		}
		if e = s.Heartbeat(testContext, p, session, testCaps(), testUsage()); e != nil {
			t.Fatal(e)
		}
	}
	o := offer(t, s, p, session)
	if _, e := s.Accept(testContext, p, session, o.Fence, UUID()); e != nil {
		t.Fatal(e)
	}
	if e := s.Fail(testContext, p, session, o.Fence, APIError{Code: "TEMPORARY_FAILURE", Message: "try again", Permanent: false}); e != nil {
		t.Fatal(e)
	}
	v, e := s.Get(testContext, site.ID, o.JobID)
	if e != nil || v.Status != "QUEUED" {
		t.Fatal("offers consumed execution attempts", e)
	}
}

func TestFairnessFIFOAndDisabledSiteBacklog(t *testing.T) {
	s, _, _ := openTest(t)
	high := testSite(t, s, 4)
	low := testSite(t, s, 1)
	p, session := testDevice(t, s)
	siteByJob := map[string]string{}
	for range 30 {
		for _, site := range []Site{high, low} {
			j := submit(t, s, site)
			siteByJob[j.ID] = site.ID
		}
	}
	if e := s.SetSite(testContext, low.ID, false, 1); e != nil {
		t.Fatal(e)
	}
	counts := map[string]int{}
	lastSeq := map[string]int64{}
	for range 20 {
		o := offer(t, s, p, session)
		siteID := siteByJob[o.JobID]
		counts[siteID]++
		var seq int64
		if e := s.db.QueryRow("SELECT seq FROM jobs WHERE site_id=? AND id=?", siteID, o.JobID).Scan(&seq); e != nil {
			t.Fatal(e)
		}
		if seq <= lastSeq[siteID] {
			t.Fatal("FIFO broken")
		}
		lastSeq[siteID] = seq
		if _, e := s.Accept(testContext, p, session, o.Fence, UUID()); e != nil {
			t.Fatal(e)
		}
		if e := s.Fail(testContext, p, session, o.Fence, APIError{Code: "TEST_FINISHED", Message: "test terminal result", Permanent: true}); e != nil {
			t.Fatal(e)
		}
	}
	if counts[high.ID] != 16 || counts[low.ID] != 4 {
		t.Fatalf("weighted fairness: %v", counts)
	}
	j := testJob(t)
	_, _, e := s.Submit(testContext, low.ID, encode(j))
	wantError(t, e, "SITE_DISABLED")
}

func TestResourceSlotsAndStableAdmission(t *testing.T) {
	s, now, _ := openTest(t)
	s.config.AdmissionStable = 15 * time.Second
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	submit(t, s, site)
	submit(t, s, site)
	v, e := s.Offer(testContext, p, session)
	if e != nil || v != nil {
		t.Fatal("started before stable interval", e)
	}
	*now = now.Add(15 * time.Second)
	o := offer(t, s, p, session)
	v, e = s.Offer(testContext, p, session)
	if e != nil || v != nil {
		t.Fatal("overbooked a reserved slot", e)
	}
	if e = s.Decline(testContext, p, session, o.Fence); e != nil {
		t.Fatal(e)
	}
	u := testUsage()
	u.CPUPercent = 80
	if e = s.Heartbeat(testContext, p, session, testCaps(), u); e != nil {
		t.Fatal(e)
	}
	v, e = s.Offer(testContext, p, session)
	if e != nil || v != nil {
		t.Fatal("CPU threshold ignored", e)
	}
	u = testUsage()
	u.FreeDiskBytes = 1 << 20
	if e = s.Heartbeat(testContext, p, session, testCaps(), u); e != nil {
		t.Fatal(e)
	}
	*now = now.Add(15 * time.Second)
	v, e = s.Offer(testContext, p, session)
	if e != nil || v != nil {
		t.Fatal("disk budget ignored", e)
	}
}

func TestIncompatibleHeadDoesNotBlock(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	audio := []Capability{{Code: "media.transcribe", RecognitionLanguages: []string{"en"}, TranslationDirections: []Pair{}, AutoDetect: true, Formats: []string{"text"}, Availability: "OFFLINE", ProfilePolicies: []string{}}}
	if _, e := s.CreateDevice(testContext, "audio", audio); e != nil {
		t.Fatal(e)
	}
	j := testJob(t)
	j.Type = "media.transcribe"
	j.Params = json.RawMessage(`{"sourceLanguage":"en","mode":"AUTO"}`)
	if _, new, e := s.Submit(testContext, site.ID, encode(j)); e != nil || !new {
		t.Fatal(e)
	}
	video := submit(t, s, site)
	o := offer(t, s, p, session)
	if o.JobID != video.ID {
		t.Fatal("incompatible head blocked video")
	}
}

func TestControlWaitsForRightsAndRejectsLateFailure(t *testing.T) {
	for _, kind := range []string{"cancel", "release"} {
		t.Run(kind, func(t *testing.T) {
			s, now, _ := openTest(t)
			site := testSite(t, s, 1)
			p, session := testDevice(t, s)
			submit(t, s, site)
			o := offer(t, s, p, session)
			if _, e := s.Accept(testContext, p, session, o.Fence, UUID()); e != nil {
				t.Fatal(e)
			}
			raw := encode(map[string]string{"protocolVersion": "2.0", "requestId": UUID(), "reason": "test"})
			v, e := s.Control(testContext, site.ID, o.JobID, kind, raw)
			if e != nil {
				t.Fatal(e)
			}
			if v.ReleaseReceipt != nil || v.Status != "CANCELLING" && v.Status != "RELEASING" {
				t.Fatal("released active rights too soon")
			}
			_, e = s.Renew(testContext, p, session, o.Fence, UUID(), StatusUpdate{Stage: "STOPPING"})
			wantError(t, e, "STOP_REQUIRED")
			*now = now.Add(121 * time.Second)
			if e = s.Expire(testContext); e != nil {
				t.Fatal(e)
			}
			v, e = s.Control(testContext, site.ID, o.JobID, kind, raw)
			if e != nil {
				t.Fatal(e)
			}
			expected := "CANCELLED"
			if kind == "release" {
				expected = "RELEASED"
				if v.ReleaseReceipt == nil || !v.ReleaseReceipt.SafeToRunLocally {
					t.Fatal("missing release receipt")
				}
			}
			if v.Status != expected {
				t.Fatal(v.Status)
			}
			if e = s.validator.Check("JobView", encode(v)); e != nil {
				t.Fatal(e)
			}
			e = s.Fail(testContext, p, session, o.Fence, APIError{Code: "LATE_FAILURE", Message: "late", Permanent: true})
			wantError(t, e, "STALE_ASSIGNMENT")
		})
	}
}

func TestHistoryTombstonesKeepActiveJobs(t *testing.T) {
	s, now, _ := openTest(t)
	site := testSite(t, s, 1)
	testDevice(t, s)
	done := submit(t, s, site)
	raw := encode(map[string]string{"protocolVersion": "2.0", "requestId": UUID(), "reason": "test"})
	if _, e := s.Control(testContext, site.ID, done.ID, "cancel", raw); e != nil {
		t.Fatal(e)
	}
	active := submit(t, s, site)
	*now = now.Add(31 * 24 * time.Hour)
	if e := s.Prune(testContext); e != nil {
		t.Fatal(e)
	}
	_, e := s.Get(testContext, site.ID, done.ID)
	wantError(t, e, "JOB_HISTORY_EXPIRED")
	_, _, e = s.Submit(testContext, site.ID, encode(done))
	wantError(t, e, "JOB_HISTORY_EXPIRED")
	done.MaxOutputBytes++
	_, _, e = s.Submit(testContext, site.ID, encode(done))
	wantError(t, e, "IDEMPOTENCY_CONFLICT")
	v, e := s.Get(testContext, site.ID, active.ID)
	if e != nil || v.Status != "QUEUED" || !v.QueueDelayed {
		t.Fatal("active work lost", e)
	}
}

func TestExecutionBudgetAndAssignedHistoryCleanup(t *testing.T) {
	s, now, _ := openTest(t)
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	j := submit(t, s, site)
	for i := 0; i < 3; i++ {
		o := offer(t, s, p, session)
		if _, e := s.Accept(testContext, p, session, o.Fence, UUID()); e != nil {
			t.Fatal(e)
		}
		if e := s.Fail(testContext, p, session, o.Fence, APIError{Code: "EXECUTOR_CRASH", Message: "temporary executor failure", Permanent: false}); e != nil {
			t.Fatal(e)
		}
		v, e := s.Get(testContext, site.ID, j.ID)
		if e != nil {
			t.Fatal(e)
		}
		expected := "QUEUED"
		if i == 2 {
			expected = "FAILED"
		}
		if v.Status != expected {
			t.Fatalf("attempt %d: %s", i+1, v.Status)
		}
		if e = s.validator.Check("JobView", encode(v)); e != nil {
			t.Fatal(e)
		}
	}
	*now = now.Add(31 * 24 * time.Hour)
	if e := s.Prune(testContext); e != nil {
		t.Fatal(e)
	}
	for _, table := range []string{"jobs", "assignments", "renewals"} {
		var count int
		if e := s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); e != nil || count != 0 {
			t.Fatalf("%s not cleaned: %d %v", table, count, e)
		}
	}
	_, _, e := s.Submit(testContext, site.ID, encode(j))
	wantError(t, e, "JOB_HISTORY_EXPIRED")
}

func TestRevokedDeviceCannotRenewOrObtainWork(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	submit(t, s, site)
	o := offer(t, s, p, session)
	if _, e := s.Accept(testContext, p, session, o.Fence, UUID()); e != nil {
		t.Fatal(e)
	}
	if e := s.RevokeToken(testContext, p.TokenID); e != nil {
		t.Fatal(e)
	}
	_, e := s.Renew(testContext, p, session, o.Fence, UUID(), StatusUpdate{Stage: "TRANSCODING"})
	wantError(t, e, "DEVICE_SESSION_INVALID")
	_, e = s.Offer(testContext, p, session)
	wantError(t, e, "DEVICE_SESSION_INVALID")
	v, e := s.Get(testContext, site.ID, o.JobID)
	if e != nil || v.Status != "RUNNING" {
		t.Fatal("revocation incorrectly freed a still-live execution right", e)
	}
}

func TestUppercaseUUIDDoesNotCreateSecondJob(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	testDevice(t, s)
	j := testJob(t)
	j.ID = "abcdef01-abcd-4abc-8abc-abcdef012345"
	if _, new, e := s.Submit(testContext, site.ID, encode(j)); e != nil || !new {
		t.Fatal(e)
	}
	j.ID = strings.ToUpper(j.ID)
	if _, new, e := s.Submit(testContext, site.ID, encode(j)); e != nil || new {
		t.Fatal("UUID case bypassed deduplication", e)
	}
	v, e := s.Get(testContext, site.ID, j.ID)
	if e != nil || v.ID != strings.ToLower(j.ID) {
		t.Fatal("UUID normalization inconsistent", e)
	}
}

func TestRestartAndExclusiveLock(t *testing.T) {
	s, now, path := openTest(t)
	site := testSite(t, s, 1)
	p, session := testDevice(t, s)
	j := submit(t, s, site)
	o := offer(t, s, p, session)
	first, e := s.Accept(testContext, p, session, o.Fence, UUID())
	if e != nil {
		t.Fatal(e)
	}
	if duplicate, e := Open(path, s.config); e == nil {
		duplicate.Close()
		t.Fatal("second dispatcher acquired database")
	}
	epoch := s.Epoch()
	cfg := s.config
	if e = s.Close(); e != nil {
		t.Fatal(e)
	}
	reopened, e := Open(path, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	reopened.now = func() time.Time { return *now }
	if reopened.Epoch() != epoch {
		t.Fatal("normal restart changed epoch")
	}
	v, new, e := reopened.Submit(testContext, site.ID, encode(j))
	if e != nil || new || v.Status != "RUNNING" {
		t.Fatal("restart lost accepted job", e)
	}
	newSession, e := reopened.Connect(testContext, p, testCaps(), testUsage(), []Fence{o.Fence})
	if e != nil {
		t.Fatal(e)
	}
	renew, e := reopened.Renew(testContext, p, newSession, o.Fence, UUID(), StatusUpdate{Stage: "ANALYZING"})
	if e != nil || renew.ExpiresAt != first.ExpiresAt {
		t.Fatal("live lease was not reconciled", e)
	}
	_, e = reopened.Renew(testContext, p, session, o.Fence, UUID(), StatusUpdate{Stage: "ANALYZING"})
	wantError(t, e, "DEVICE_SESSION_INVALID")
}

func TestHTTPIsolationTokensAndSchema(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	other := testSite(t, s, 1)
	p, _ := testDevice(t, s)
	tokenView, token, e := s.IssueToken(testContext, "SITE", site.ID)
	if e != nil {
		t.Fatal(e)
	}
	_, otherToken, e := s.IssueToken(testContext, "SITE", other.ID)
	if e != nil {
		t.Fatal(e)
	}
	_, deviceToken, e := s.IssueToken(testContext, "DEVICE", p.ID)
	if e != nil {
		t.Fatal(e)
	}
	handler := Handler(s)
	request := func(method, path, secret string, raw []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+secret)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	j := testJob(t)
	w := request("POST", "/api/v2/site/jobs", token, encode(j))
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	if e = s.validator.Check("JobView", w.Body.Bytes()); e != nil {
		t.Fatal(e)
	}
	w = request("POST", "/api/v2/site/jobs", token, encode(j))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = request("GET", "/api/v2/site/jobs/"+j.ID, otherToken, nil)
	if w.Code != 404 {
		t.Fatal("other site accessed job", w.Code)
	}
	w = request("POST", "/api/v2/site/jobs", deviceToken, encode(j))
	if w.Code != 401 {
		t.Fatal("device token accepted as site token")
	}
	w = request("GET", "/api/v2/site/capabilities", token, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if e = s.validator.Check("Capabilities", w.Body.Bytes()); e != nil {
		t.Fatal(e)
	}
	w = request("GET", "/api/v2/site/jobs?limit=1", token, nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if e = s.validator.Check("JobPage", w.Body.Bytes()); e != nil {
		t.Fatal(e)
	}
	w = request("POST", "/api/site/jobs", token, encode(j))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "PROTOCOL_UPGRADE_REQUIRED") {
		t.Fatal(w.Code, w.Body.String())
	}
	tokens, e := s.Tokens(testContext)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(encode(tokens)), token) {
		t.Fatal("token list exposed plaintext")
	}
	var stored string
	if e = s.db.QueryRow("SELECT hash FROM tokens WHERE id=?", tokenView.TokenID).Scan(&stored); e != nil || stored == token {
		t.Fatal("token not hashed", e)
	}
	if e = s.RevokeToken(testContext, tokenView.TokenID); e != nil {
		t.Fatal(e)
	}
	w = request("GET", "/api/v2/site/jobs", token, nil)
	if w.Code != 401 {
		t.Fatal("revoked token accepted")
	}
}

func TestCrashWriter(t *testing.T) {
	if os.Getenv("DISPATCHER_TEST_CRASH_DB") == "" {
		t.Skip("subprocess helper")
	}
	s, e := Open(os.Getenv("DISPATCHER_TEST_CRASH_DB"), DefaultConfig())
	if e != nil {
		t.Fatal(e)
	}
	j := testJob(t)
	j.ID = os.Getenv("DISPATCHER_TEST_CRASH_JOB")
	if _, new, e := s.Submit(testContext, os.Getenv("DISPATCHER_TEST_CRASH_SITE"), encode(j)); e != nil || !new {
		t.Fatal(e)
	}
	os.Exit(0)
}
func TestCommittedQueueSurvivesAbruptProcessExit(t *testing.T) {
	s, _, path := openTest(t)
	site := testSite(t, s, 1)
	testDevice(t, s)
	cfg := s.config
	if e := s.Close(); e != nil {
		t.Fatal(e)
	}
	id := UUID()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashWriter$")
	cmd.Env = append(os.Environ(), "DISPATCHER_TEST_CRASH_DB="+path, "DISPATCHER_TEST_CRASH_SITE="+site.ID, "DISPATCHER_TEST_CRASH_JOB="+id)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("crash helper: %v %s", e, out)
	}
	reopened, e := Open(path, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	v, e := reopened.Get(testContext, site.ID, id)
	if e != nil || v.Status != "QUEUED" {
		t.Fatal("committed queue disappeared after abrupt exit", e)
	}
}

func BenchmarkDurableQueue(b *testing.B) {
	s, _, _ := openTest(b)
	site := testSite(b, s, 1)
	testDevice(b, s)
	j := testJob(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		j.ID = UUID()
		if _, _, e := s.Submit(testContext, site.ID, encode(j)); e != nil {
			b.Fatal(e)
		}
	}
}

// Optional stable load for OS-level memory/CPU sampling; enabled explicitly, not every test run.
func TestStage2Load(t *testing.T) {
	if os.Getenv("DISPATCHER_STAGE2_LOAD") != "1" {
		t.Skip("load profile opt-in")
	}
	s, _, _ := openTest(t)
	sites := []Site{}
	for range 10 {
		sites = append(sites, testSite(t, s, 1))
	}
	for range 20 {
		testDevice(t, s)
	}
	for i := range 2000 {
		j := testJob(t)
		if _, _, e := s.Submit(testContext, sites[i%len(sites)].ID, encode(j)); e != nil {
			t.Fatal(e)
		}
	}
	var count int
	if e := s.db.QueryRow("SELECT count(*) FROM jobs").Scan(&count); e != nil || count != 2000 {
		t.Fatal("load queue count", e, count)
	}
	for range 20 {
		for _, site := range sites {
			if _, _, e := s.List(testContext, site.ID, 0, 20); e != nil {
				t.Fatal(e)
			}
		}
	}
	fmt.Println("stage2 load ready: 2000 jobs, 10 sites, 20 registered device sessions")
	time.Sleep(3 * time.Second)
}
