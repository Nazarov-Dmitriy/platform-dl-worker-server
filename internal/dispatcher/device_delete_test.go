package dispatcher

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestDeviceDeleteRevokesAccessAndCannotBeReenabled(t *testing.T) {
	s, _, _ := openTest(t)
	device, err := s.CreateDevice(testContext, "Windows", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err := s.IssueToken(testContext, "DEVICE", device.ID)
	if err != nil {
		t.Fatal(err)
	}
	actor := AdminActor{ID: "deletion-owner", Role: "OWNER"}
	if err = s.AdminDeleteDevice(testContext, actor, device.ID, `"1"`); err != nil {
		t.Fatal(err)
	}
	list, err := s.Devices(testContext)
	if err != nil || len(list) != 0 {
		t.Fatalf("deleted device still visible: %v %v", list, err)
	}
	if _, err = s.Authenticate(testContext, secret, "DEVICE"); err == nil {
		t.Fatal("deleted device token still works")
	}
	if _, _, err = s.IssueToken(testContext, "DEVICE", device.ID); err == nil {
		t.Fatal("new token issued for deleted device")
	}
	if err = s.SetDevice(testContext, device.ID, true); err == nil {
		t.Fatal("CLI reenabled deleted device")
	}
	if _, err = s.AdminUpdateDevice(testContext, actor, device.ID, `"2"`, []byte(`{"name":"revived","enabled":true}`)); err == nil {
		t.Fatal("admin reenabled deleted device")
	}
	var deleted, enabled int
	if err = s.db.QueryRow("SELECT deleted,enabled FROM devices WHERE id=?", device.ID).Scan(&deleted, &enabled); err != nil || deleted != 1 || enabled != 0 {
		t.Fatal("device history identity was not retained")
	}
}

func TestDeviceDeleteRefusesActiveAssignmentsAndKeepsClosedHistory(t *testing.T) {
	for _, state := range []string{"OFFERED", "RUNNING", "CANCELLING", "RELEASING", "CLOSED"} {
		t.Run(state, func(t *testing.T) {
			s, _, _ := openTest(t)
			site := testSite(t, s, 1)
			device, err := s.CreateDevice(testContext, "Mac", nil)
			if err != nil {
				t.Fatal(err)
			}
			result, err := s.db.Exec("INSERT INTO jobs(site_id,id,fingerprint,request,view,status,created_at,updated_at) VALUES(?,?,?,'{}','{}','QUEUED',1,1)", site.ID, UUID(), "delete-history-fixture")
			if err != nil {
				t.Fatal(err)
			}
			seq, err := result.LastInsertId()
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.db.Exec("INSERT INTO assignments(id,job_seq,device_id,session_id,generation,epoch,state,offer_until) VALUES(?,?,?,'session',1,'epoch',?,1)", UUID(), seq, device.ID, state)
			if err != nil {
				t.Fatal(err)
			}
			err = s.AdminDeleteDevice(testContext, AdminActor{ID: "owner", Role: "OWNER"}, device.ID, `"1"`)
			if state == "CLOSED" && err != nil {
				t.Fatal(err)
			}
			if state != "CLOSED" && err == nil {
				t.Fatal("active assignment device was deleted")
			}
			var assignments, jobs int
			s.db.QueryRow("SELECT count(*) FROM assignments").Scan(&assignments)
			s.db.QueryRow("SELECT count(*) FROM jobs").Scan(&jobs)
			if assignments != 1 || jobs != 1 {
				t.Fatal("job history changed")
			}
		})
	}
}

func TestDeviceDeleteHTTPRequiresOwnerCSRFAndMatchingRevision(t *testing.T) {
	srv, store := adminServer(t)
	owner, session := login(t, srv, "owner", "owner-password-1")
	csrf := session["csrfToken"].(string)
	device, err := store.CreateDevice(testContext, "Delete HTTP", nil)
	if err != nil {
		t.Fatal(err)
	}
	url := srv.URL + "/api/v2/admin/devices/" + device.ID
	response := adminDo(t, owner, "POST", srv.URL+"/api/v2/admin/accounts", csrf, map[string]any{"login": "delete-operator", "password": "operator-pass-1", "role": "OPERATOR", "enabled": true, "manageSites": false})
	response.Body.Close()
	operator, opSession := login(t, srv, "delete-operator", "operator-pass-1")
	for _, test := range []struct {
		client      *http.Client
		csrf, match string
		status      int
	}{
		{http.DefaultClient, "", `"1"`, 401}, {operator, opSession["csrfToken"].(string), `"1"`, 403}, {owner, "", `"1"`, 403}, {owner, csrf, "", 428}, {owner, csrf, `"9"`, 409}, {owner, csrf, `"1"`, 204}, {owner, csrf, `"1"`, 404},
	} {
		request, _ := http.NewRequest("DELETE", url, nil)
		request.Header.Set("X-CSRF-Token", test.csrf)
		if test.match != "" {
			request.Header.Set("If-Match", test.match)
		}
		response, err := test.client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != test.status {
			var body any
			json.NewDecoder(response.Body).Decode(&body)
			t.Fatal(fmt.Sprintf("wanted %d, got %d: %v", test.status, response.StatusCode, body))
		}
		response.Body.Close()
	}
}

func TestDeviceDeletionMigrationPreservesExistingData(t *testing.T) {
	s, _, _ := openTest(t)
	device, _ := testDevice(t, s)
	_, secret, err := s.IssueToken(testContext, "DEVICE", device.ID)
	if err != nil {
		t.Fatal(err)
	}
	site := testSite(t, s, 1)
	job := submit(t, s, site)
	if _, err = s.db.Exec("ALTER TABLE devices DROP COLUMN deleted"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("DELETE FROM schema_migrations WHERE version=6"); err != nil {
		t.Fatal(err)
	}
	location := s.path
	s.Close()
	upgraded, err := Open(location, DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	devices, err := upgraded.Devices(testContext)
	if err != nil || len(devices) != 1 || devices[0].ID != device.ID {
		t.Fatalf("devices changed: %v %v", devices, err)
	}
	if _, err = upgraded.Authenticate(testContext, secret, "DEVICE"); err != nil {
		t.Fatal("existing token invalid after migration", err)
	}
	view, err := upgraded.Get(testContext, site.ID, job.ID)
	if err != nil || view.Status != "QUEUED" {
		t.Fatal("existing job changed", err)
	}
}
