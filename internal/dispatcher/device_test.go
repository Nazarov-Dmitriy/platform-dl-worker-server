package dispatcher

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func wsSend(t *testing.T, c *websocket.Conn, kind, id string, body any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(testContext, 3*time.Second)
	defer cancel()
	e := c.Write(ctx, websocket.MessageText, encode(deviceFrame{"2.0", id, kind, "UP", encode(body)}))
	if e != nil {
		t.Fatal(e)
	}
}
func wsRead(t *testing.T, c *websocket.Conn, kind string) deviceFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(testContext, 4*time.Second)
	defer cancel()
	for {
		_, raw, e := c.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		var f deviceFrame
		if e = json.Unmarshal(raw, &f); e != nil {
			t.Fatal(e)
		}
		if f.Type == kind {
			return f
		}
	}
}
func wsHello(t *testing.T, c *websocket.Conn, id string, active []map[string]any) {
	t.Helper()
	if active == nil {
		active = []map[string]any{}
	}
	wsSend(t, c, "device.hello", UUID(), map[string]any{"deviceId": id, "agentVersion": "test", "os": "windows", "architecture": "amd64", "memoryBytes": 8 << 30, "cpuCores": 8, "accelerators": []string{}, "capabilities": testCaps(), "usage": testUsage(), "active": active})
	wsRead(t, c, "session.welcome")
}
func wsDial(t *testing.T, url, token string) *websocket.Conn {
	t.Helper()
	c, _, e := websocket.Dial(testContext, "ws"+strings.TrimPrefix(url, "http")+"/api/v2/device/connect", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}
func TestDeviceTransportReconnectAndDurableAck(t *testing.T) {
	s, _, _ := openTest(t)
	s.now = time.Now
	site := testSite(t, s, 1)
	device, e := s.CreateDevice(testContext, "ws", testCaps())
	if e != nil {
		t.Fatal(e)
	}
	_, token, e := s.IssueToken(testContext, "DEVICE", device.ID)
	if e != nil {
		t.Fatal(e)
	}
	h := Handler(s).(*HTTP)
	server := httptest.NewServer(h)
	defer server.Close()
	defer h.CloseDevices()
	c := wsDial(t, server.URL, token)
	wsHello(t, c, device.ID, nil)
	j := submit(t, s, site)
	var offer Offer
	if e = json.Unmarshal(wsRead(t, c, "job.offer").Body, &offer); e != nil {
		t.Fatal(e)
	}
	id := UUID()
	wsSend(t, c, "job.accept", id, map[string]any{"jobId": j.ID, "fence": offer.Fence})
	var first Lease
	json.Unmarshal(wsRead(t, c, "lease.granted").Body, &first)
	// Lost grant: reconnect explicitly reconciles the same assignment and same accept ID.
	c2 := wsDial(t, server.URL, token)
	wsHello(t, c2, device.ID, []map[string]any{{"jobId": j.ID, "fence": offer.Fence}})
	ctx, cancel := context.WithTimeout(testContext, time.Second)
	defer cancel()
	if _, _, e = c.Read(ctx); e == nil {
		t.Fatal("old connection remained open")
	}
	wsSend(t, c2, "job.accept", id, map[string]any{"jobId": j.ID, "fence": offer.Fence})
	var again Lease
	json.Unmarshal(wsRead(t, c2, "lease.granted").Body, &again)
	if first.ExpiresAt != again.ExpiresAt {
		t.Fatal("accept replay extended lease")
	}
	// A valid fence must not authorize a different job ID.
	wsSend(t, c2, "job.status", UUID(), map[string]any{"jobId": UUID(), "fence": offer.Fence, "renewalId": UUID(), "stage": "ANALYZING", "progress": nil, "activitySequence": 0, "steps": []Step{}})
	wsRead(t, c2, "protocol.error")
	failedID := UUID()
	failed := map[string]any{"jobId": j.ID, "fence": offer.Fence, "error": APIError{Code: "TEST_EXECUTOR_ONLY", Message: "test", Permanent: true}}
	wsSend(t, c2, "job.failed", failedID, failed)
	wsRead(t, c2, "protocol.ack")
	wsSend(t, c2, "job.failed", failedID, failed)
	wsRead(t, c2, "protocol.ack")
	view, e := s.Get(testContext, site.ID, j.ID)
	if e != nil || view.Status != "FAILED" {
		t.Fatalf("%v %+v", e, view)
	}
	revision := view.Revision
	// The durable terminal replay also works after changing sessions.
	c3 := wsDial(t, server.URL, token)
	wsHello(t, c3, device.ID, nil)
	wsSend(t, c3, "job.failed", failedID, failed)
	wsRead(t, c3, "protocol.ack")
	view, _ = s.Get(testContext, site.ID, j.ID)
	if view.Revision != revision {
		t.Fatal("duplicate mutated job")
	}
	failed["error"] = APIError{Code: "ALTERED_ERROR", Message: "different", Permanent: true}
	wsSend(t, c3, "job.failed", failedID, failed)
	wsRead(t, c3, "protocol.error")
}
func TestDeviceTransportCancelAndAuthorization(t *testing.T) {
	s, _, _ := openTest(t)
	s.now = time.Now
	site := testSite(t, s, 1)
	device, _ := s.CreateDevice(testContext, "ws", testCaps())
	_, token, _ := s.IssueToken(testContext, "DEVICE", device.ID)
	_, siteToken, _ := s.IssueToken(testContext, "SITE", site.ID)
	h := Handler(s).(*HTTP)
	server := httptest.NewServer(h)
	defer server.Close()
	defer h.CloseDevices()
	c, resp, e := websocket.Dial(testContext, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/v2/device/connect", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + siteToken}}})
	if c != nil {
		c.CloseNow()
	}
	if e == nil || resp.StatusCode != 401 {
		t.Fatalf("site token accepted %v", e)
	}
	c = wsDial(t, server.URL, token)
	wsHello(t, c, device.ID, nil)
	j := submit(t, s, site)
	var o Offer
	json.Unmarshal(wsRead(t, c, "job.offer").Body, &o)
	wsSend(t, c, "job.accept", UUID(), map[string]any{"jobId": j.ID, "fence": o.Fence})
	wsRead(t, c, "lease.granted")
	_, e = s.Control(testContext, site.ID, j.ID, "cancel", encode(map[string]any{"protocolVersion": "2.0", "requestId": UUID(), "reason": "test"}))
	if e != nil {
		t.Fatal(e)
	}
	wsRead(t, c, "job.stop")
	wsSend(t, c, "job.stopped", UUID(), map[string]any{"jobId": j.ID, "fence": o.Fence})
	wsRead(t, c, "protocol.ack")
	v, _ := s.Get(testContext, site.ID, j.ID)
	if v.Status != "CANCELLED" {
		t.Fatal(v.Status)
	}
}

func TestDeviceTLSUpgrade(t *testing.T) {
	s, _, _ := openTest(t)
	s.now = time.Now
	d, _ := s.CreateDevice(testContext, "tls", testCaps())
	_, token, _ := s.IssueToken(testContext, "DEVICE", d.ID)
	h := Handler(s).(*HTTP)
	server := httptest.NewTLSServer(h)
	defer server.Close()
	defer h.CloseDevices()
	c, _, e := websocket.Dial(testContext, "wss"+strings.TrimPrefix(server.URL, "https")+"/api/v2/device/connect", &websocket.DialOptions{HTTPClient: server.Client(), HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}}})
	if e != nil {
		t.Fatal(e)
	}
	defer c.CloseNow()
	wsHello(t, c, d.ID, nil)
}
