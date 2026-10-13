package dispatcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type deviceRecordKey struct{}
type deviceRecord struct {
	Principal                Principal
	Session, ID, Fingerprint string
}
type deviceFrame struct {
	ProtocolVersion string          `json:"protocolVersion"`
	MessageID       string          `json:"messageId"`
	Type            string          `json:"type"`
	Direction       string          `json:"direction"`
	Body            json.RawMessage `json:"body"`
}
type deviceBody struct {
	DeviceID     string       `json:"deviceId"`
	JobID        string       `json:"jobId"`
	Fence        Fence        `json:"fence"`
	Capabilities []Capability `json:"capabilities"`
	Usage        Usage        `json:"usage"`
	Active       []struct {
		JobID string `json:"jobId"`
		Fence Fence  `json:"fence"`
	} `json:"active"`
	RenewalID        string   `json:"renewalId"`
	Stage            string   `json:"stage"`
	Progress         *float64 `json:"progress"`
	ActivitySequence int64    `json:"activitySequence"`
	Steps            []Step   `json:"steps"`
	Error            APIError `json:"error"`
}
type deviceHub struct {
	sync.Mutex
	connections map[string]*websocket.Conn
	closed      bool
}

func newDeviceHub() *deviceHub { return &deviceHub{connections: map[string]*websocket.Conn{}} }
func (h *HTTP) CloseDevices() {
	h.hub.Lock()
	defer h.hub.Unlock()
	h.hub.closed = true
	for _, c := range h.hub.connections {
		_ = c.CloseNow()
	}
}
func (h *HTTP) deviceWrite(ctx context.Context, c *websocket.Conn, kind string, body any) error {
	frame := deviceFrame{"2.0", UUID(), kind, "DOWN", encode(body)}
	if e := h.store.validator.Check("DeviceMessage", encode(frame)); e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, encode(frame))
}
func (h *HTTP) deviceConnect(w http.ResponseWriter, r *http.Request) {
	p, e := h.store.Authenticate(r.Context(), bearer(r), "DEVICE")
	if e != nil {
		h.failure(w, e)
		return
	}
	// This endpoint is for native agents. Browser sites use their server-side SITE API.
	if r.Header.Get("Origin") != "" {
		h.failure(w, problem(403, "NATIVE_DEVICE_REQUIRED", "Browser connections are not accepted"))
		return
	}
	c, e := websocket.Accept(w, r, nil)
	if e != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(MaxMetadataBytes)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	helloCtx, helloCancel := context.WithTimeout(ctx, 10*time.Second)
	_, raw, e := c.Read(helloCtx)
	helloCancel()
	if e != nil {
		return
	}
	var frame deviceFrame
	var body deviceBody
	if h.store.validator.Check("DeviceMessage", raw) != nil || json.Unmarshal(raw, &frame) != nil || frame.Type != "device.hello" || frame.Direction != "UP" || json.Unmarshal(frame.Body, &body) != nil || body.DeviceID != p.ID {
		return
	}
	active := make([]Fence, 0, len(body.Active))
	activeJobs := map[string]string{}
	for _, item := range body.Active {
		active = append(active, item.Fence)
		activeJobs[item.Fence.AssignmentID] = item.JobID
	}
	h.hub.Lock()
	if h.hub.closed {
		h.hub.Unlock()
		return
	}
	session, e := h.store.Connect(ctx, p, body.Capabilities, body.Usage, active, activeJobs)
	if e != nil {
		h.hub.Unlock()
		return
	}
	if old := h.hub.connections[p.ID]; old != nil {
		_ = old.CloseNow()
	}
	h.hub.connections[p.ID] = c
	h.hub.Unlock()
	defer func() {
		h.hub.Lock()
		if h.hub.connections[p.ID] == c {
			delete(h.hub.connections, p.ID)
		}
		h.hub.Unlock()
		_, _ = h.store.db.Exec("UPDATE devices SET session_id='',session_token='',last_seen=0,ready_since=0 WHERE id=? AND session_id=?", p.ID, session)
	}()
	cfg := h.store.config
	if h.deviceWrite(ctx, c, "session.welcome", map[string]any{"sessionId": session, "dispatcherEpoch": h.store.epoch, "heartbeatSeconds": int(cfg.HeartbeatInterval / time.Second), "leaseSeconds": int(cfg.LeaseTTL / time.Second), "stopSafetySeconds": int(cfg.StopSafety / time.Second)}) != nil {
		return
	}
	for _, item := range body.Active {
		valid := false
		_ = h.store.transaction(ctx, func(tx *sql.Tx) error {
			a, _, err := lookupAssignment(tx, p, session, item.Fence, item.JobID)
			valid = err == nil && a.state == "RUNNING" && a.leaseUntil > h.store.now().UnixMilli()
			return nil
		})
		if !valid {
			if h.deviceWrite(ctx, c, "job.stop", map[string]any{"jobId": item.JobID, "fence": item.Fence, "reason": "RECONCILE_STOP"}) != nil {
				return
			}
		}
	}
	incoming := make(chan []byte, 1)
	go func() {
		defer close(incoming)
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				return
			}
			select {
			case incoming <- b:
			case <-ctx.Done():
				return
			}
		}
	}()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case raw, ok := <-incoming:
			if !ok {
				return
			}
			if h.store.validator.Check("DeviceMessage", raw) != nil || json.Unmarshal(raw, &frame) != nil || frame.Direction != "UP" {
				return
			}
			body = deviceBody{}
			if json.Unmarshal(frame.Body, &body) != nil {
				return
			}
			e = h.deviceDispatch(ctx, p, session, frame, body, c)
			if e != nil {
				var api *APIError
				if !errors.As(e, &api) {
					api = &APIError{Code: "INTERNAL_ERROR", Message: "Dispatcher operation failed", Permanent: false}
				}
				if h.deviceWrite(ctx, c, "protocol.error", map[string]any{"replyTo": frame.MessageID, "error": api}) != nil {
					return
				}
				if api.Code == "DEVICE_SESSION_INVALID" {
					return
				}
			}
		case <-ticker.C:
			if h.deviceTick(ctx, p, session, c) != nil {
				return
			}
		}
	}
}
func (h *HTTP) deviceDispatch(ctx context.Context, p Principal, session string, f deviceFrame, b deviceBody, c *websocket.Conn) error {
	switch f.Type {
	case "device.heartbeat":
		return h.store.Heartbeat(ctx, p, session, b.Capabilities, b.Usage)
	case "job.accept", "job.status":
		var lease Lease
		var e error
		if f.Type == "job.accept" {
			lease, e = h.store.Accept(ctx, p, session, b.Fence, f.MessageID, b.JobID)
		} else {
			lease, e = h.store.Renew(ctx, p, session, b.Fence, b.RenewalID, StatusUpdate{b.Stage, b.Progress, b.ActivitySequence, b.Steps}, b.JobID)
		}
		if e != nil {
			return e
		}
		return h.deviceWrite(ctx, c, "lease.granted", lease)
	case "job.decline", "job.failed", "job.stopped":
		canonical, e := canonicalTransform(encode(f))
		if e != nil {
			return e
		}
		ctx = context.WithValue(ctx, deviceRecordKey{}, deviceRecord{p, session, f.MessageID, digest(canonical)})
		switch f.Type {
		case "job.decline":
			e = h.store.Decline(ctx, p, session, b.Fence, b.JobID)
		case "job.failed":
			e = h.store.Fail(ctx, p, session, b.Fence, b.Error, b.JobID)
		case "job.stopped":
			e = h.store.Stopped(ctx, p, session, b.Fence, b.JobID)
		}
		if e != nil {
			return e
		}
		return h.deviceWrite(ctx, c, "protocol.ack", map[string]string{"replyTo": f.MessageID})
	default:
		return problem(501, "STAGE_NOT_IMPLEMENTED", "This device operation is not implemented yet")
	}
}
func (h *HTTP) deviceTick(ctx context.Context, p Principal, session string, c *websocket.Conn) error {
	var stops []map[string]any
	e := h.store.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		var seen int64
		if e := tx.QueryRow("SELECT last_seen FROM devices WHERE id=?", p.ID).Scan(&seen); e != nil {
			return e
		}
		if h.store.now().UnixMilli()-seen > h.store.config.OnlineTTL.Milliseconds() {
			return problem(403, "DEVICE_OFFLINE", "Heartbeat deadline elapsed")
		}
		rows, e := tx.Query("SELECT a.id,a.generation,a.epoch,j.id,a.state FROM assignments a JOIN jobs j ON j.seq=a.job_seq WHERE a.device_id=? AND a.session_id=? AND a.state IN ('CANCELLING','RELEASING')", p.ID, session)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var f Fence
			var id, state string
			if e = rows.Scan(&f.AssignmentID, &f.Generation, &f.DispatcherEpoch, &id, &state); e != nil {
				return e
			}
			stops = append(stops, map[string]any{"jobId": id, "fence": f, "reason": state})
		}
		return rows.Err()
	})
	if e != nil {
		return e
	}
	for _, stop := range stops {
		if e = h.deviceWrite(ctx, c, "job.stop", stop); e != nil {
			return e
		}
	}
	offer, e := h.store.Offer(ctx, p, session)
	if e != nil {
		return e
	}
	if offer != nil {
		return h.deviceWrite(ctx, c, "job.offer", offer)
	}
	return nil
}
