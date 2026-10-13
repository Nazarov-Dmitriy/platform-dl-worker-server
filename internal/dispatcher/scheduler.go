package dispatcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"sort"
	"time"
)

func compatible(r JobRequest, caps []Capability, online bool) bool {
	for _, c := range caps {
		if c.Code != r.Type || c.Availability == "NOT_INSTALLED" || online && c.Availability != "ONLINE" {
			continue
		}
		if r.Type == "media.transcode" {
			var p struct {
				Profile struct {
					EncoderPolicy string `json:"encoderPolicy"`
				} `json:"profile"`
			}
			_ = json.Unmarshal(r.Params, &p)
			if contains(c.Formats, "hls") && contains(c.ProfilePolicies, p.Profile.EncoderPolicy) {
				return true
			}
			continue
		}
		var p struct {
			SourceLanguage string `json:"sourceLanguage"`
			Speech         struct {
				SourceLanguage string `json:"sourceLanguage"`
			} `json:"speech"`
			IncludeOriginal bool     `json:"includeOriginal"`
			TargetLanguages []string `json:"targetLanguages"`
			Formats         []string `json:"formats"`
		}
		_ = json.Unmarshal(r.Params, &p)
		lang := p.SourceLanguage
		if r.Type == "media.subtitles" {
			lang = p.Speech.SourceLanguage
		}
		if lang == "auto" && !c.AutoDetect || lang != "auto" && !contains(c.RecognitionLanguages, lang) {
			continue
		}
		if r.Type == "media.transcribe" {
			if contains(c.Formats, "text") {
				return true
			}
			continue
		}
		formatOK := true
		for _, format := range p.Formats {
			if !contains(c.Formats, format) {
				formatOK = false
			}
		}
		if !formatOK {
			continue
		}
		sources := []string{lang}
		if lang == "auto" {
			sources = c.RecognitionLanguages
		}
		for _, source := range sources {
			all := true
			for _, target := range p.TargetLanguages {
				if target == source {
					continue
				}
				pairOK := false
				for _, pair := range c.TranslationDirections {
					if pair.Source == source && pair.Target == target {
						pairOK = true
					}
				}
				if !pairOK {
					all = false
				}
			}
			if all {
				return true
			}
		}
	}
	return false
}
func supportedByAny(tx *sql.Tx, r JobRequest) (bool, error) {
	rows, e := tx.Query("SELECT capabilities FROM devices WHERE enabled=1")
	if e != nil {
		return false, e
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if e = rows.Scan(&raw); e != nil {
			return false, e
		}
		var caps []Capability
		if e = json.Unmarshal([]byte(raw), &caps); e != nil {
			return false, e
		}
		if compatible(r, caps, false) {
			return true, nil
		}
	}
	return false, rows.Err()
}
func (s *Store) admissible(u Usage) bool {
	return !u.Paused && u.WorkDiskAvailable && u.AvailableSlots > 0 && u.CPUPercent < s.config.CPUThreshold && u.MemoryUsedPercent < s.config.MemoryThreshold && u.DiskUsedPercent < s.config.DiskThreshold && u.MemoryPressure == "NORMAL" && u.FreeMemoryBytes >= s.config.MinimumFreeMemory && (u.EncoderBusyPercent == nil || *u.EncoderBusyPercent < s.config.CPUThreshold)
}
func checkDevice(tx *sql.Tx, p Principal, session string) error {
	var n int
	e := tx.QueryRow("SELECT count(*) FROM devices d JOIN tokens t ON t.id=? AND t.principal_id=d.id AND t.purpose='DEVICE' AND t.revoked=0 WHERE d.id=? AND d.enabled=1 AND (?='' OR (d.session_id=? AND d.session_token=t.id))", p.TokenID, p.ID, session, session).Scan(&n)
	if e != nil {
		return e
	}
	if n == 0 || p.Purpose != "DEVICE" {
		return problem(403, "DEVICE_SESSION_INVALID", "Device token or session is no longer valid")
	}
	return nil
}

// Connect is the transport-independent registration boundary. Stage 3 wires it to WSS.
// Reconnect preserves unexpired rights only when the agent explicitly reconciles them.
func (s *Store) Connect(ctx context.Context, p Principal, caps []Capability, usage Usage, active []Fence) (string, error) {
	if e := s.checkCaps(caps); e != nil {
		return "", e
	}
	if e := s.validator.Check("Usage", encode(usage)); e != nil {
		return "", e
	}
	session := UUID()
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, ""); e != nil {
			return e
		}
		now := s.now()
		ready := int64(0)
		if s.admissible(usage) {
			ready = now.UnixMilli()
		}
		if _, e := tx.Exec("UPDATE devices SET session_id=?,session_token=?,last_seen=?,ready_since=?,capabilities=?,usage=? WHERE id=?", session, p.TokenID, now.UnixMilli(), ready, string(encode(caps)), string(encode(usage)), p.ID); e != nil {
			return e
		}
		for _, f := range active {
			if f.DispatcherEpoch != s.epoch {
				continue
			}
			if _, e := tx.Exec("UPDATE assignments SET session_id=? WHERE id=? AND device_id=? AND epoch=? AND generation=? AND state IN ('RUNNING','CANCELLING','RELEASING') AND lease_until>?", session, f.AssignmentID, p.ID, f.DispatcherEpoch, f.Generation, now.UnixMilli()); e != nil {
				return e
			}
		}
		return audit(tx, now.UnixMilli(), "DEVICE_CONNECTED", p.ID, "")
	})
	return session, e
}
func (s *Store) Heartbeat(ctx context.Context, p Principal, session string, caps []Capability, usage Usage) error {
	if e := s.checkCaps(caps); e != nil {
		return e
	}
	if e := s.validator.Check("Usage", encode(usage)); e != nil {
		return e
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		now := s.now()
		var ready, seen int64
		if e := tx.QueryRow("SELECT ready_since,last_seen FROM devices WHERE id=?", p.ID).Scan(&ready, &seen); e != nil {
			return e
		}
		if !s.admissible(usage) {
			ready = 0
		} else if ready == 0 || now.UnixMilli()-seen > s.config.OnlineTTL.Milliseconds() {
			ready = now.UnixMilli()
		}
		_, e := tx.Exec("UPDATE devices SET last_seen=?,ready_since=?,capabilities=?,usage=? WHERE id=?", now.UnixMilli(), ready, string(encode(caps)), string(encode(usage)), p.ID)
		return e
	})
}

type candidate struct {
	seq      int64
	site, id string
	weight   int
	request  JobRequest
	credit   int
}

func (s *Store) Offer(ctx context.Context, p Principal, session string) (*Offer, error) {
	var offer *Offer
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		now := s.now()
		if e := s.expireTx(tx, now); e != nil {
			return e
		}
		var seen, ready int64
		var capsRaw, usageRaw string
		if e := tx.QueryRow("SELECT last_seen,ready_since,capabilities,usage FROM devices WHERE id=?", p.ID).Scan(&seen, &ready, &capsRaw, &usageRaw); e != nil {
			return e
		}
		var caps []Capability
		var usage Usage
		if e := json.Unmarshal([]byte(capsRaw), &caps); e != nil {
			return e
		}
		if e := json.Unmarshal([]byte(usageRaw), &usage); e != nil {
			return e
		}
		if now.UnixMilli()-seen > s.config.OnlineTTL.Milliseconds() || ready == 0 || now.Sub(time.UnixMilli(ready)) < s.config.AdmissionStable || !s.admissible(usage) {
			return nil
		}
		var booked int
		if e := tx.QueryRow("SELECT count(*) FROM assignments WHERE device_id=? AND state!='CLOSED'", p.ID).Scan(&booked); e != nil {
			return e
		}
		if booked >= usage.AvailableSlots {
			return nil
		}
		// FIFO within each compatible site's backlog; incompatible head entries do not block it.
		rows, e := tx.Query("SELECT j.seq,j.site_id,j.id,j.request,s.weight FROM jobs j JOIN sites s ON s.id=j.site_id WHERE j.status='QUEUED' ORDER BY j.seq")
		if e != nil {
			return e
		}
		candidates := map[string]*candidate{}
		for rows.Next() {
			var c candidate
			var raw []byte
			if e = rows.Scan(&c.seq, &c.site, &c.id, &raw, &c.weight); e != nil {
				rows.Close()
				return e
			}
			if e = json.Unmarshal(raw, &c.request); e != nil {
				rows.Close()
				return e
			}
			if _, ok := candidates[c.site]; !ok && compatible(c.request, caps, true) && usage.FreeDiskBytes >= c.request.Source.Bytes && usage.FreeDiskBytes-c.request.Source.Bytes >= c.request.MaxOutputBytes {
				copy := c
				candidates[c.site] = &copy
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		credits := map[string]int{}
		rows, e = tx.Query("SELECT site_id,credit FROM scheduler_credits WHERE device_id=?", p.ID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var id string
			var credit int
			if e = rows.Scan(&id, &credit); e != nil {
				rows.Close()
				return e
			}
			credits[id] = credit
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		same := len(credits) == len(candidates)
		for id := range candidates {
			if _, ok := credits[id]; !ok {
				same = false
			}
		}
		if !same {
			if _, e = tx.Exec("DELETE FROM scheduler_credits WHERE device_id=?", p.ID); e != nil {
				return e
			}
			credits = map[string]int{}
		}
		if len(candidates) == 0 {
			return nil
		}
		ids := make([]string, 0, len(candidates))
		for id := range candidates {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		var winner *candidate
		total := 0
		for _, id := range ids {
			c := candidates[id]
			c.credit = credits[id] + c.weight
			total += c.weight
			if winner == nil || c.credit > winner.credit {
				winner = c
			}
		}
		winner.credit -= total
		for _, id := range ids {
			c := candidates[id]
			if _, e = tx.Exec("INSERT INTO scheduler_credits(device_id,site_id,credit) VALUES(?,?,?) ON CONFLICT(device_id,site_id) DO UPDATE SET credit=excluded.credit", p.ID, id, c.credit); e != nil {
				return e
			}
		}
		r, e := loadJob(tx, winner.site, winner.id)
		if e != nil {
			return e
		}
		r.generation++
		id := UUID()
		until := now.Add(s.config.OfferTTL)
		if _, e = tx.Exec("INSERT INTO assignments(id,job_seq,device_id,session_id,generation,epoch,state,offer_until) VALUES(?,?,?,?,?,?,'OFFERED',?)", id, r.seq, p.ID, session, r.generation, s.epoch, until.UnixMilli()); e != nil {
			return e
		}
		r.view.Status = "ASSIGNED"
		r.view.Progress = nil
		r.view.Stage = ""
		r.assignment = sql.NullString{String: id, Valid: true}
		if e = saveJob(tx, &r, now); e != nil {
			return e
		}
		offer = &Offer{r.request.ID, Fence{id, r.generation, s.epoch}, stamp(until), r.request}
		return audit(tx, now.UnixMilli(), "JOB_ASSIGNED", p.ID, r.request.ID)
	})
	return offer, e
}

type assignment struct {
	id                                           string
	seq                                          int64
	device, session, epoch, state                string
	generation, offerUntil, leaseUntil, activity int64
}

func lookupAssignment(tx *sql.Tx, p Principal, session string, f Fence) (assignment, jobRow, error) {
	var a assignment
	var r jobRow
	if e := checkDevice(tx, p, session); e != nil {
		return a, r, e
	}
	e := tx.QueryRow("SELECT id,job_seq,device_id,session_id,epoch,state,generation,offer_until,lease_until,activity_sequence FROM assignments WHERE id=?", f.AssignmentID).Scan(&a.id, &a.seq, &a.device, &a.session, &a.epoch, &a.state, &a.generation, &a.offerUntil, &a.leaseUntil, &a.activity)
	if errors.Is(e, sql.ErrNoRows) {
		return a, r, problem(409, "STALE_ASSIGNMENT", "Assignment is no longer valid")
	}
	if e != nil {
		return a, r, e
	}
	if a.device != p.ID || a.session != session || a.epoch != f.DispatcherEpoch || a.generation != f.Generation || a.state == "CLOSED" {
		return a, r, problem(409, "STALE_ASSIGNMENT", "Assignment is no longer valid")
	}
	var site, id string
	if e = tx.QueryRow("SELECT site_id,id FROM jobs WHERE seq=?", a.seq).Scan(&site, &id); e != nil {
		return a, r, e
	}
	r, e = loadJob(tx, site, id)
	if e == nil && (!r.assignment.Valid || r.assignment.String != a.id) {
		e = problem(409, "STALE_ASSIGNMENT", "Assignment replaced")
	}
	return a, r, e
}
func (s *Store) Accept(ctx context.Context, p Principal, session string, f Fence, renewalID string) (Lease, error) {
	return s.renew(ctx, p, session, f, renewalID, nil)
}
func (s *Store) Renew(ctx context.Context, p Principal, session string, f Fence, renewalID string, update StatusUpdate) (Lease, error) {
	if update.Progress != nil && (*update.Progress < 0 || *update.Progress > 1) || update.ActivitySequence < 0 {
		return Lease{}, problem(400, "INVALID_STATUS", "Invalid progress")
	}
	if !contains([]string{"WAITING_SOURCE", "DOWNLOADING", "ANALYZING", "TRANSCODING", "TRANSCRIBING", "TRANSLATING", "PACKAGING", "WAITING_UPLOAD", "UPLOADING", "WAITING_PUBLICATION", "STOPPING"}, update.Stage) {
		return Lease{}, problem(400, "INVALID_STATUS", "Invalid stage")
	}
	for _, step := range update.Steps {
		if e := s.validator.Check("Step", encode(step)); e != nil {
			return Lease{}, e
		}
	}
	return s.renew(ctx, p, session, f, renewalID, &update)
}
func (s *Store) renew(ctx context.Context, p Principal, session string, f Fence, renewalID string, update *StatusUpdate) (Lease, error) {
	var result Lease
	if len(renewalID) != 36 || uuid.Validate(renewalID) != nil {
		return result, problem(400, "INVALID_RENEWAL_ID", "Renewal ID must be a UUID")
	}
	if e := s.validator.Check("Fence", encode(f)); e != nil {
		return result, e
	}
	fp := digest(encode(update))
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		a, r, e := lookupAssignment(tx, p, session, f)
		if e != nil {
			return e
		}
		now := s.now()
		if a.state == "RUNNING" && a.leaseUntil <= now.UnixMilli() || a.state == "OFFERED" && a.offerUntil <= now.UnixMilli() {
			return problem(409, "LEASE_EXPIRED", "Assignment deadline elapsed")
		}
		if a.state != "OFFERED" && a.state != "RUNNING" {
			return problem(409, "STOP_REQUIRED", "Stop requested for this assignment")
		}
		var prior, oldFP []byte
		e = tx.QueryRow("SELECT response,fingerprint FROM renewals WHERE assignment_id=? AND id=?", a.id, renewalID).Scan(&prior, &oldFP)
		if e == nil {
			if string(oldFP) != fp {
				return problem(409, "IDEMPOTENCY_CONFLICT", "Renewal ID content changed")
			}
			return json.Unmarshal(prior, &result)
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		if update == nil && a.state != "OFFERED" || update != nil && a.state != "RUNNING" {
			return problem(409, "INVALID_TRANSITION", "Accept or status is out of order")
		}
		until := now.Add(s.config.LeaseTTL)
		result = Lease{r.request.ID, f, renewalID, int(s.config.LeaseTTL / time.Second), stamp(until)}
		if update == nil {
			r.attempts++
			r.view.Status = "RUNNING"
			r.view.LastProgressAt = stamp(now)
		} else {
			if update.ActivitySequence < a.activity {
				return problem(409, "STALE_PROGRESS", "Activity sequence decreased")
			}
			if update.ActivitySequence > a.activity {
				r.view.LastProgressAt = stamp(now)
			}
			r.view.Stage = update.Stage
			r.view.Progress = update.Progress
			if update.Steps != nil {
				r.view.Steps = update.Steps
			}
			a.activity = update.ActivitySequence
		}
		if _, e = tx.Exec("UPDATE assignments SET state='RUNNING',lease_until=?,activity_sequence=? WHERE id=?", until.UnixMilli(), a.activity, a.id); e != nil {
			return e
		}
		if _, e = tx.Exec("INSERT INTO renewals(assignment_id,id,fingerprint,response) VALUES(?,?,?,?)", a.id, renewalID, fp, encode(result)); e != nil {
			return e
		}
		if e = saveJob(tx, &r, now); e != nil {
			return e
		}
		return nil
	})
	return result, e
}
func (s *Store) Decline(ctx context.Context, p Principal, session string, f Fence) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		a, r, e := lookupAssignment(tx, p, session, f)
		if e != nil {
			return e
		}
		if a.state != "OFFERED" {
			return problem(409, "INVALID_TRANSITION", "Cannot decline a granted assignment")
		}
		return s.closeAssignment(tx, &r, a, "QUEUED", nil, s.now())
	})
}
func (s *Store) Fail(ctx context.Context, p Principal, session string, f Fence, cause APIError) error {
	if e := s.validator.Check("Error", encode(cause)); e != nil {
		return e
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		a, r, e := lookupAssignment(tx, p, session, f)
		if e != nil {
			return e
		}
		now := s.now()
		if a.state != "RUNNING" || a.leaseUntil <= now.UnixMilli() {
			return problem(409, "STALE_ASSIGNMENT", "Cannot fail an expired assignment")
		}
		status := "QUEUED"
		if cause.Permanent || r.attempts >= s.config.ExecutorAttempts {
			status = "FAILED"
		}
		return s.closeAssignment(tx, &r, a, status, &cause, now)
	})
}
func (s *Store) closeAssignment(tx *sql.Tx, r *jobRow, a assignment, status string, cause *APIError, now time.Time) error {
	if _, e := tx.Exec("UPDATE assignments SET state='CLOSED' WHERE id=?", a.id); e != nil {
		return e
	}
	r.assignment = sql.NullString{}
	r.view.Status = status
	r.view.Progress = nil
	r.view.Stage = ""
	r.view.Error = nil
	if status == "QUEUED" {
		r.view.Steps = []Step{}
	} else if status == "FAILED" {
		r.view.Error = cause
		r.view.ManualEntryOffered = r.request.Type != "media.transcode"
	}
	if status == "RELEASED" {
		var id string
		if e := tx.QueryRow("SELECT id FROM controls WHERE site_id=? AND job_id=? AND kind='release' ORDER BY rowid LIMIT 1", r.site, r.request.ID).Scan(&id); e != nil {
			return e
		}
		r.view.ReleaseReceipt = &ReleaseReceipt{id, r.request.ID, stamp(now), s.epoch, "ALL_EXTERNAL_ATTEMPTS", true}
	}
	if e := saveJob(tx, r, now); e != nil {
		return e
	}
	return audit(tx, now.UnixMilli(), "JOB_"+status, r.site, r.request.ID)
}
func (s *Store) Stopped(ctx context.Context, p Principal, session string, f Fence) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		a, r, e := lookupAssignment(tx, p, session, f)
		if e != nil {
			return e
		}
		if a.state != "CANCELLING" && a.state != "RELEASING" {
			return problem(409, "INVALID_TRANSITION", "No stop requested")
		}
		status := "CANCELLED"
		if a.state == "RELEASING" {
			status = "RELEASED"
		}
		return s.closeAssignment(tx, &r, a, status, nil, s.now())
	})
}
func (s *Store) Expire(ctx context.Context) error {
	return s.transaction(ctx, func(tx *sql.Tx) error { return s.expireTx(tx, s.now()) })
}
func (s *Store) expireTx(tx *sql.Tx, now time.Time) error {
	rows, e := tx.Query("SELECT a.id,a.job_seq,a.state,j.site_id,j.id FROM assignments a JOIN jobs j ON j.seq=a.job_seq WHERE (a.state='OFFERED' AND a.offer_until<=?) OR (a.state IN ('RUNNING','CANCELLING','RELEASING') AND a.lease_until<=?)", now.UnixMilli(), now.UnixMilli())
	if e != nil {
		return e
	}
	type expired struct {
		a        assignment
		site, id string
	}
	list := []expired{}
	for rows.Next() {
		var x expired
		if e = rows.Scan(&x.a.id, &x.a.seq, &x.a.state, &x.site, &x.id); e != nil {
			rows.Close()
			return e
		}
		list = append(list, x)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, x := range list {
		r, e := loadJob(tx, x.site, x.id)
		if e != nil {
			return e
		}
		status := "QUEUED"
		cause := &APIError{Code: "EXECUTION_RETRIES_EXHAUSTED", Message: "Execution lease expired too many times", Permanent: false}
		switch x.a.state {
		case "CANCELLING":
			status = "CANCELLED"
		case "RELEASING":
			status = "RELEASED"
		case "RUNNING":
			if r.attempts >= s.config.ExecutorAttempts {
				status = "FAILED"
			}
		}
		if e = s.closeAssignment(tx, &r, x.a, status, cause, now); e != nil {
			return e
		}
	}
	return nil
}
func (s *Store) Control(ctx context.Context, site, id, kind string, raw []byte) (JobView, error) {
	var view JobView
	if kind != "cancel" && kind != "release" {
		return view, problem(400, "INVALID_CONTROL", "Unknown control")
	}
	if e := s.validator.Check("Mutation", raw); e != nil {
		return view, e
	}
	var request struct {
		RequestID string `json:"requestId"`
	}
	_ = json.Unmarshal(raw, &request)
	canonical, e := canonicalJSON(raw)
	if e != nil {
		return view, e
	}
	fp := digest(canonical)
	e = s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := loadJob(tx, site, id)
		if e != nil {
			return e
		}
		var oldFP, oldKind string
		e = tx.QueryRow("SELECT fingerprint,kind FROM controls WHERE site_id=? AND job_id=? AND id=?", site, id, request.RequestID).Scan(&oldFP, &oldKind)
		if e == nil {
			if oldFP != fp || oldKind != kind {
				return problem(409, "IDEMPOTENCY_CONFLICT", "Control ID content changed")
			}
			view = s.decorated(r)
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		if r.view.Status == "PUBLISHING" {
			return problem(409, "PUBLICATION_IN_PROGRESS", "Publication is already being committed")
		}
		if terminal(r.view.Status) {
			if kind == "cancel" && r.view.Status == "CANCELLED" || kind == "release" && r.view.Status == "RELEASED" {
				view = s.decorated(r)
				return nil
			}
			return problem(409, "JOB_TERMINAL", "Job already finished")
		}
		if r.view.Status == "CANCELLING" || r.view.Status == "RELEASING" {
			return problem(409, "CONTROL_IN_PROGRESS", "Another control is already in progress")
		}
		if _, e = tx.Exec("INSERT INTO controls(site_id,job_id,id,fingerprint,kind) VALUES(?,?,?,?,?)", site, id, request.RequestID, fp, kind); e != nil {
			return e
		}
		now := s.now()
		status := "CANCELLED"
		if kind == "release" {
			status = "RELEASED"
		}
		if r.view.Status == "RUNNING" {
			status = "CANCELLING"
			if kind == "release" {
				status = "RELEASING"
			}
			if _, e = tx.Exec("UPDATE assignments SET state=? WHERE id=?", status, r.assignment.String); e != nil {
				return e
			}
			r.view.Status = status
			if e = saveJob(tx, &r, now); e != nil {
				return e
			}
		} else {
			a := assignment{id: r.assignment.String}
			if e = s.closeAssignment(tx, &r, a, status, nil, now); e != nil {
				return e
			}
		}
		view = s.decorated(r)
		return nil
	})
	return view, e
}
func canonicalJSON(raw []byte) ([]byte, error) { return canonicalTransform(raw) }
func (s *Store) Capabilities(ctx context.Context, site string) (map[string]any, error) {
	var result map[string]any
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var opsRaw string
		if e := tx.QueryRow("SELECT operations FROM sites WHERE id=?", site).Scan(&opsRaw); errors.Is(e, sql.ErrNoRows) {
			return problem(403, "FORBIDDEN", "Unknown site")
		} else if e != nil {
			return e
		}
		var allowed []string
		if e := json.Unmarshal([]byte(opsRaw), &allowed); e != nil {
			return e
		}
		rows, e := tx.Query("SELECT d.capabilities,d.last_seen,d.session_id,EXISTS(SELECT 1 FROM tokens t WHERE t.id=d.session_token AND t.revoked=0) FROM devices d WHERE enabled=1")
		if e != nil {
			return e
		}
		aggregated := map[string]Capability{}
		for _, op := range allowed {
			aggregated[op] = Capability{Code: op, RecognitionLanguages: []string{}, TranslationDirections: []Pair{}, Formats: []string{"text"}, Availability: "NOT_INSTALLED", ProfilePolicies: []string{}}
		}
		now := s.now()
		for rows.Next() {
			var raw, session string
			var seen int64
			var tokenOK bool
			if e = rows.Scan(&raw, &seen, &session, &tokenOK); e != nil {
				rows.Close()
				return e
			}
			var caps []Capability
			if e = json.Unmarshal([]byte(raw), &caps); e != nil {
				rows.Close()
				return e
			}
			for _, cap := range caps {
				current, ok := aggregated[cap.Code]
				if !ok || cap.Availability == "NOT_INSTALLED" {
					continue
				}
				live := session != "" && tokenOK && now.UnixMilli()-seen <= s.config.OnlineTTL.Milliseconds() && cap.Availability == "ONLINE"
				if current.Availability == "NOT_INSTALLED" {
					current.Formats = []string{}
				}
				if live {
					current.Availability = "ONLINE"
				} else if current.Availability != "ONLINE" {
					current.Availability = "OFFLINE"
				}
				current.AutoDetect = current.AutoDetect || cap.AutoDetect
				for _, lang := range cap.RecognitionLanguages {
					if !contains(current.RecognitionLanguages, lang) {
						current.RecognitionLanguages = append(current.RecognitionLanguages, lang)
					}
				}
				for _, format := range cap.Formats {
					if !contains(current.Formats, format) {
						current.Formats = append(current.Formats, format)
					}
				}
				for _, policy := range cap.ProfilePolicies {
					if !contains(current.ProfilePolicies, policy) {
						current.ProfilePolicies = append(current.ProfilePolicies, policy)
					}
				}
				for _, pair := range cap.TranslationDirections {
					found := false
					for _, old := range current.TranslationDirections {
						if old == pair {
							found = true
						}
					}
					if !found {
						current.TranslationDirections = append(current.TranslationDirections, pair)
					}
				}
				aggregated[cap.Code] = current
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		out := []Capability{}
		for _, op := range allowed {
			c := aggregated[op]
			sort.Strings(c.RecognitionLanguages)
			sort.Strings(c.Formats)
			sort.Strings(c.ProfilePolicies)
			sort.Slice(c.TranslationDirections, func(i, j int) bool {
				return c.TranslationDirections[i].Source+c.TranslationDirections[i].Target < c.TranslationDirections[j].Source+c.TranslationDirections[j].Target
			})
			out = append(out, c)
		}
		body := encode(out)
		result = map[string]any{"protocolVersion": "2.0", "revision": digest(body), "checkedAt": stamp(now), "operations": out}
		if e = s.validator.Check("Capabilities", encode(result)); e != nil {
			return problem(503, "CAPABILITIES_TOO_LARGE", "Capability catalogue exceeds wire limits")
		}
		return nil
	})
	return result, e
}
