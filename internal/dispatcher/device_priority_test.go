package dispatcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"
)

func setTestPriority(t *testing.T, s *Store, p Principal, priority int) {
	t.Helper()
	view, err := s.deviceView(testContext, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.AdminUpdateDevice(testContext, AdminActor{ID: "test"}, p.ID,
		fmt.Sprintf("\"%v\"", view["revision"]), encode(map[string]any{
			"name": view["name"], "enabled": true, "priority": priority,
		}))
	if err != nil {
		t.Fatal(err)
	}
}

func TestDevicePriorityFallback(t *testing.T) {
	for _, scenario := range []string{"ready", "paused", "cpu", "memory", "disk", "space", "incompatible", "offline", "revoked", "occupied", "stabilizing"} {
		t.Run(scenario, func(t *testing.T) {
			s, now, _ := openTest(t)
			site := testSite(t, s, 1)
			main, session := testDevice(t, s)
			helper, helperSession := testDevice(t, s)
			setTestPriority(t, s, main, 100)
			caps, usage := testCaps(), testUsage()
			switch scenario {
			case "paused":
				usage.Paused = true
			case "cpu":
				usage.CPUPercent = 100
			case "memory":
				usage.FreeMemoryBytes = 0
			case "disk":
				usage.WorkDiskAvailable = false
			case "space":
				usage.FreeDiskBytes = 1
			case "incompatible":
				caps[0].ProfilePolicies = []string{"HARDWARE_ALLOWED"}
			case "occupied":
				submit(t, s, site)
				offer(t, s, main, session)
			}
			if err := s.Heartbeat(testContext, main, session, caps, usage); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "offline":
				*now = now.Add(s.config.OnlineTTL + time.Second)
				if err := s.Heartbeat(testContext, helper, helperSession, testCaps(), testUsage()); err != nil {
					t.Fatal(err)
				}
			case "revoked":
				if _, err := s.db.Exec("UPDATE tokens SET revoked=1 WHERE id=?", main.TokenID); err != nil {
					t.Fatal(err)
				}
			case "stabilizing":
				s.config.AdmissionStable = time.Second
				if _, err := s.db.Exec("UPDATE devices SET ready_since=? WHERE id=?", now.Add(-time.Minute).UnixMilli(), helper.ID); err != nil {
					t.Fatal(err)
				}
			}
			submit(t, s, site)
			got, err := s.Offer(testContext, helper, helperSession)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "ready" {
				if got != nil {
					t.Fatal("helper took work while main was ready")
				}
				offer(t, s, main, session)
			} else if got == nil {
				t.Fatal("unavailable main blocked helper")
			}
		})
	}
}

func TestDevicePriorityChangePreservesAssignmentAndRestart(t *testing.T) {
	s, _, path := openTest(t)
	site := testSite(t, s, 1)
	main, session := testDevice(t, s)
	helper, helperSession := testDevice(t, s)
	setTestPriority(t, s, main, 100)
	submit(t, s, site)
	active := offer(t, s, main, session)
	if _, err := s.Accept(testContext, main, session, active.Fence, UUID()); err != nil {
		t.Fatal(err)
	}
	setTestPriority(t, s, main, 0)
	setTestPriority(t, s, helper, 100)
	var status string
	if err := s.db.QueryRow("SELECT state FROM assignments WHERE id=?", active.Fence.AssignmentID).Scan(&status); err != nil || status != "RUNNING" {
		t.Fatalf("role change affected active assignment: %s %v", status, err)
	}
	submit(t, s, site)
	offer(t, s, helper, helperSession)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, s.config)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	view, err := reopened.deviceView(testContext, helper.ID)
	if err != nil || view["priority"] != 100 {
		t.Fatalf("role not persisted: %v %v", view, err)
	}
}

func TestDevicePriorityConcurrentEqualRoles(t *testing.T) {
	for _, priority := range []int{0, 100} {
		t.Run(fmt.Sprint(priority), func(t *testing.T) {
			s, _, _ := openTest(t)
			site := testSite(t, s, 1)
			type device struct {
				p       Principal
				session string
			}
			devices := make([]device, 4)
			for i := range devices {
				devices[i].p, devices[i].session = testDevice(t, s)
				setTestPriority(t, s, devices[i].p, priority)
			}
			submit(t, s, site)
			var wg sync.WaitGroup
			results := make(chan *Offer, len(devices))
			for _, d := range devices {
				wg.Add(1)
				go func(d device) {
					defer wg.Done()
					got, err := s.Offer(testContext, d.p, d.session)
					if err != nil {
						t.Error(err)
					}
					results <- got
				}(d)
			}
			wg.Wait()
			close(results)
			count := 0
			for got := range results {
				if got != nil {
					count++
				}
			}
			if count != 1 {
				t.Fatalf("one job received %d assignments", count)
			}
		})
	}
}

func TestDevicePriorityMultipleMainsRecover(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	first, firstSession := testDevice(t, s)
	second, secondSession := testDevice(t, s)
	helper, helperSession := testDevice(t, s)
	setTestPriority(t, s, first, 100)
	setTestPriority(t, s, second, 100)
	submit(t, s, site)
	offer(t, s, first, firstSession)
	submit(t, s, site)
	if got, err := s.Offer(testContext, helper, helperSession); err != nil || got != nil {
		t.Fatalf("second available main must take precedence: %v %v", got, err)
	}
	offer(t, s, second, secondSession)
	submit(t, s, site)
	offer(t, s, helper, helperSession)
	// Increasing capacity makes the main eligible again without moving existing work.
	usage := testUsage()
	usage.AvailableSlots = 2
	if err := s.Heartbeat(testContext, first, firstSession, testCaps(), usage); err != nil {
		t.Fatal(err)
	}
	usage.AvailableSlots = 2
	if err := s.Heartbeat(testContext, helper, helperSession, testCaps(), usage); err != nil {
		t.Fatal(err)
	}
	submit(t, s, site)
	if got, err := s.Offer(testContext, helper, helperSession); err != nil || got != nil {
		t.Fatalf("recovered main must take precedence: %v %v", got, err)
	}
	offer(t, s, first, firstSession)
}

func TestDevicePrioritySingleDevice(t *testing.T) {
	for _, priority := range []int{0, 100} {
		t.Run(fmt.Sprint(priority), func(t *testing.T) {
			s, _, _ := openTest(t)
			site := testSite(t, s, 1)
			p, session := testDevice(t, s)
			setTestPriority(t, s, p, priority)
			submit(t, s, site)
			offer(t, s, p, session)
		})
	}
}

func TestDevicePriorityHTTPValidation(t *testing.T) {
	srv, s := adminServer(t)
	owner, session := login(t, srv, "owner", "owner-password-1")
	p, _ := testDevice(t, s)
	endpoint := srv.URL + "/api/v2/admin/devices/" + p.ID
	csrf := session["csrfToken"].(string)
	for _, tc := range []struct {
		name, csrf, match string
		priority, status  int
	}{
		{"missing csrf", "", `"1"`, 100, 403},
		{"missing revision", csrf, "", 100, 428},
		{"invalid priority", csrf, `"1"`, 101, 400},
		{"save main", csrf, `"1"`, 100, 200},
		{"stale revision", csrf, `"1"`, 0, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest("PUT", endpoint, bytes.NewReader(encode(map[string]any{
				"name": "test device", "enabled": true, "priority": tc.priority,
			})))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-CSRF-Token", tc.csrf)
			req.Header.Set("If-Match", tc.match)
			resp, err := owner.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var body map[string]any
			json.NewDecoder(resp.Body).Decode(&body)
			if resp.StatusCode != tc.status {
				t.Fatalf("wanted %d, got %d: %v", tc.status, resp.StatusCode, body)
			}
		})
	}
	view, err := s.deviceView(testContext, p.ID)
	if err != nil || view["priority"] != 100 {
		t.Fatalf("failed request changed saved role: %v %v", view, err)
	}
}
