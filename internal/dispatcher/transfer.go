package dispatcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strings"
)

func fenceEqual(a, b Fence) bool {
	return a.AssignmentID == b.AssignmentID && a.Generation == b.Generation && a.DispatcherEpoch == b.DispatcherEpoch
}
func formatGeneration(n int64) string {
	return strings.Trim(string(encode(n)), "\n\"")
}

func (s *Store) RequestSource(ctx context.Context, p Principal, session string, f Fence, jobID string) error {
	if e := s.validator.Check("Fence", encode(f)); e != nil {
		return e
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		a, r, e := lookupAssignment(tx, p, session, f, jobID)
		if e != nil {
			return e
		}
		now := s.now()
		if a.state != "RUNNING" || a.leaseUntil <= now.UnixMilli() {
			return problem(409, "STALE_ASSIGNMENT", "Source can be requested only with a live lease")
		}
		var existing string
		e = tx.QueryRow("SELECT id FROM transfers WHERE job_seq=? AND kind='SOURCE' AND assignment_id=?", r.seq, a.id).Scan(&existing)
		if e == nil {
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		id := UUID()
		if _, e = tx.Exec("INSERT INTO transfers(id,job_seq,device_id,kind,assignment_id,generation,epoch,source_revision,status,created_at) VALUES(?,?,?,'SOURCE',?,?,?,?,'OPEN',?)", id, r.seq, p.ID, a.id, a.generation, a.epoch, r.request.Source.Revision, now.UnixMilli()); e != nil {
			return e
		}
		r.view.Actionable = true
		r.view.Stage = "WAITING_SOURCE"
		if e = saveJob(tx, &r, now); e != nil {
			return e
		}
		return audit(tx, now.UnixMilli(), "TRANSFER_SOURCE", r.site, r.request.ID)
	})
}

func (s *Store) ProposeArtifact(ctx context.Context, p Principal, session string, f Fence, jobID string, art Artifact) error {
	if e := s.validator.Check("Artifact", encode(art)); e != nil {
		return e
	}
	if !fenceEqual(art.Fence, f) {
		return problem(400, "INVALID_REQUEST", "Artifact fence must match the assignment")
	}
	canonical, e := canonicalTransform(encode(art.Manifest))
	if e != nil {
		return problem(400, "INVALID_REQUEST", "Manifest is not canonical JSON")
	}
	if digest(canonical) != art.ManifestSHA256 {
		return problem(400, "INVALID_REQUEST", "manifestSha256 does not match JCS(manifest)")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		a, r, e := lookupAssignment(tx, p, session, f, jobID)
		if e != nil {
			return e
		}
		now := s.now()
		if a.state != "RUNNING" || a.leaseUntil <= now.UnixMilli() {
			return problem(409, "STALE_ASSIGNMENT", "Cannot propose an artifact without a live lease")
		}
		if e = validateManifest(r.request, art); e != nil {
			return e
		}
		var existing []byte
		e = tx.QueryRow("SELECT artifact FROM transfers WHERE job_seq=? AND kind='UPLOAD' AND assignment_id=?", r.seq, a.id).Scan(&existing)
		if e == nil {
			var old Artifact
			if json.Unmarshal(existing, &old) != nil {
				return problem(500, "INTERNAL_ERROR", "Stored artifact is unreadable")
			}
			if old.ID != art.ID || old.ManifestSHA256 != art.ManifestSHA256 {
				return problem(409, "ARTIFACT_CONFLICT", "This attempt already proposed a different artifact")
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		id := UUID()
		if _, e = tx.Exec("INSERT INTO transfers(id,job_seq,device_id,kind,assignment_id,generation,epoch,artifact,status,created_at) VALUES(?,?,?,'UPLOAD',?,?,?,?,'OPEN',?)", id, r.seq, p.ID, a.id, a.generation, a.epoch, encode(art), now.UnixMilli()); e != nil {
			return e
		}
		if _, e = tx.Exec("UPDATE transfers SET status='COMPLETED' WHERE job_seq=? AND kind='SOURCE' AND assignment_id=?", r.seq, a.id); e != nil {
			return e
		}
		r.view.Artifact = &art
		r.view.Actionable = true
		r.view.Stage = "WAITING_UPLOAD"
		r.view.Steps = art.Manifest.Steps
		if e = saveJob(tx, &r, now); e != nil {
			return e
		}
		return audit(tx, now.UnixMilli(), "ARTIFACT_PROPOSED", r.site, r.request.ID)
	})
}

func (s *Store) CompleteUpload(ctx context.Context, p Principal, session string, f Fence, jobID, artifactID, hash string) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		var device, state string
		e := tx.QueryRow("SELECT device_id,state FROM assignments WHERE id=? AND generation=? AND epoch=?", f.AssignmentID, f.Generation, f.DispatcherEpoch).Scan(&device, &state)
		if errors.Is(e, sql.ErrNoRows) || device != p.ID {
			return problem(409, "STALE_ASSIGNMENT", "Assignment is no longer valid")
		}
		if e != nil {
			return e
		}
		var site string
		if e = tx.QueryRow("SELECT j.site_id FROM assignments a JOIN jobs j ON j.seq=a.job_seq WHERE a.id=?", f.AssignmentID).Scan(&site); e != nil {
			return e
		}
		r, e := loadJob(tx, site, jobID)
		if e != nil {
			return e
		}
		now := s.now()
		if state == "CLOSED" && r.view.Status == "AWAITING_PUBLICATION" && r.view.Artifact != nil && r.view.Artifact.ID == artifactID && r.view.Artifact.ManifestSHA256 == hash {
			return nil
		}
		a, r, e := lookupAssignment(tx, p, session, f, jobID)
		if e != nil {
			return e
		}
		if a.state != "RUNNING" || a.leaseUntil <= now.UnixMilli() {
			return problem(409, "STALE_ASSIGNMENT", "Upload complete requires a live lease")
		}
		var raw []byte
		var status, id string
		e = tx.QueryRow("SELECT id,artifact,status FROM transfers WHERE job_seq=? AND kind='UPLOAD' AND assignment_id=?", r.seq, a.id).Scan(&id, &raw, &status)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(409, "INVALID_TRANSITION", "Artifact must be proposed before complete")
		}
		if e != nil {
			return e
		}
		var art Artifact
		if json.Unmarshal(raw, &art) != nil {
			return e
		}
		if art.ID != artifactID || art.ManifestSHA256 != hash {
			return problem(409, "ARTIFACT_CONFLICT", "Complete does not match the proposed artifact")
		}
		if status == "COMPLETED" {
			return nil
		}
		if e = requireCompleteGrant(tx, id, requiredPaths(art.Manifest.Files)); e != nil {
			return e
		}
		if _, e = tx.Exec("UPDATE transfers SET status='COMPLETED' WHERE id=?", id); e != nil {
			return e
		}
		r.view.Status = "AWAITING_PUBLICATION"
		r.view.Stage = ""
		r.view.Progress = nil
		r.view.Artifact = &art
		r.view.Actionable = true
		r.view.Steps = art.Manifest.Steps
		if _, e = tx.Exec("UPDATE assignments SET state='CLOSED' WHERE id=?", a.id); e != nil {
			return e
		}
		r.assignment = sql.NullString{}
		if e = saveJob(tx, &r, now); e != nil {
			return e
		}
		return audit(tx, now.UnixMilli(), "JOB_AWAITING_PUBLICATION", r.site, r.request.ID)
	})
}

func (s *Store) ListTransfers(ctx context.Context, site, jobID string) (map[string]any, error) {
	var page map[string]any
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := loadJob(tx, site, jobID)
		if e != nil {
			return e
		}
		rows, e := tx.Query("SELECT id,kind,assignment_id,generation,epoch,source_revision,artifact FROM transfers WHERE job_seq=? AND status='OPEN' ORDER BY created_at,id", r.seq)
		if e != nil {
			return e
		}
		defer rows.Close()
		requests := []TransferRequest{}
		for rows.Next() {
			var item TransferRequest
			var src sql.NullString
			var art []byte
			if e = rows.Scan(&item.ID, &item.Kind, &item.Fence.AssignmentID, &item.Fence.Generation, &item.Fence.DispatcherEpoch, &src, &art); e != nil {
				return e
			}
			item.SourceRevision = src.String
			if len(art) > 0 {
				var a Artifact
				if e = json.Unmarshal(art, &a); e != nil {
					return e
				}
				item.Artifact = &a
			}
			requests = append(requests, item)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		page = map[string]any{"protocolVersion": "2.0", "requests": requests, "nextCursor": nil}
		return s.validator.Check("TransferPage", encode(page))
	})
	return page, e
}

func (s *Store) GrantTransfer(ctx context.Context, site, jobID string, raw []byte) (GrantDelivery, error) {
	var out GrantDelivery
	if e := s.validator.Check("TransferGrant", raw); e != nil {
		return out, e
	}
	var grant TransferGrant
	if json.Unmarshal(raw, &grant) != nil {
		return out, problem(400, "INVALID_REQUEST", "Invalid transfer grant")
	}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := loadJob(tx, site, jobID)
		if e != nil {
			return e
		}
		var t struct {
			id, device, kind, status string
			fence                    Fence
			artifact                 []byte
		}
		e = tx.QueryRow("SELECT id,device_id,kind,status,assignment_id,generation,epoch,artifact FROM transfers WHERE id=?", grant.RequestID).Scan(&t.id, &t.device, &t.kind, &t.status, &t.fence.AssignmentID, &t.fence.Generation, &t.fence.DispatcherEpoch, &t.artifact)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Transfer request not found")
		}
		if e != nil {
			return e
		}
		if t.status != "OPEN" || !fenceEqual(t.fence, grant.Fence) {
			return problem(409, "STALE_ASSIGNMENT", "Grant does not match the open transfer")
		}
		required, method, e := requiredGrant(r, t.kind, t.artifact, t.fence)
		if e != nil {
			return e
		}
		if e = validateLinks(grant, required, method, r.site, r.request.ID, t.fence, t.kind, r.request); e != nil {
			return e
		}
		mapping := mappingFingerprint(grant.Links)
		var oldFP string
		e = tx.QueryRow("SELECT mapping_fp FROM transfer_pages WHERE request_id=? AND page=?", grant.RequestID, grant.Page).Scan(&oldFP)
		if e == nil {
			if oldFP != mapping {
				return problem(409, "IDEMPOTENCY_CONFLICT", "Grant page mapping cannot change")
			}
		} else if !errors.Is(e, sql.ErrNoRows) {
			return e
		} else if _, e = tx.Exec("INSERT INTO transfer_pages(request_id,page,last_page,mapping_fp,links,delivered) VALUES(?,?,?,?,?,0)", grant.RequestID, grant.Page, grant.LastPage, mapping, encode(grant)); e != nil {
			return e
		}
		if _, e = tx.Exec("UPDATE transfer_pages SET links=?,last_page=?,delivered=0 WHERE request_id=? AND page=?", encode(grant), grant.LastPage, grant.RequestID, grant.Page); e != nil {
			return e
		}
		if grant.LastPage {
			if e = requireCompleteGrant(tx, grant.RequestID, required); e != nil {
				return e
			}
		}
		out = GrantDelivery{t.device, t.kind, r.request.ID, t.fence, grant}
		return nil
	})
	return out, e
}

func (s *Store) ClaimPublication(ctx context.Context, site, jobID string, raw []byte) (PublicationClaim, error) {
	var claim PublicationClaim
	if e := s.validator.Check("PublicationClaimRequest", raw); e != nil {
		return claim, e
	}
	var req struct {
		ClaimID        string `json:"claimId"`
		ArtifactID     string `json:"artifactId"`
		ManifestSHA256 string `json:"manifestSha256"`
		Fence          Fence  `json:"fence"`
	}
	_ = json.Unmarshal(raw, &req)
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := loadJob(tx, site, jobID)
		if e != nil {
			return e
		}
		now := s.now()
		var stored []byte
		var claimID string
		e = tx.QueryRow("SELECT claim_id,claim FROM publications WHERE job_seq=?", r.seq).Scan(&claimID, &stored)
		if e == nil {
			if claimID == req.ClaimID && digest(stored) == digest(encode(req)) {
				if r.view.PublicationClaim != nil {
					claim = *r.view.PublicationClaim
					return nil
				}
			}
			if claimID != req.ClaimID || digest(stored) != digest(encode(req)) {
				return problem(409, "PUBLICATION_IN_PROGRESS", "A different publication claim is already recorded")
			}
			if r.view.PublicationClaim != nil {
				claim = *r.view.PublicationClaim
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		if r.view.Status != "AWAITING_PUBLICATION" || r.view.Artifact == nil {
			return problem(409, "INVALID_TRANSITION", "Publication can be claimed after upload complete")
		}
		if r.view.Artifact.ID != req.ArtifactID || r.view.Artifact.ManifestSHA256 != req.ManifestSHA256 || !fenceEqual(r.view.Artifact.Fence, req.Fence) {
			return problem(409, "STALE_ASSIGNMENT", "Claim does not match the current artifact")
		}
		claim = PublicationClaim{"2.0", req.ClaimID, req.ArtifactID, req.Fence, stamp(now)}
		if _, e = tx.Exec("INSERT INTO publications(job_seq,claim_id,claim,delivered) VALUES(?,?,?,0)", r.seq, req.ClaimID, encode(req)); e != nil {
			return e
		}
		r.view.Status = "PUBLISHING"
		r.view.PublicationClaim = &claim
		r.view.Actionable = true
		if e = saveJob(tx, &r, now); e != nil {
			return e
		}
		return audit(tx, now.UnixMilli(), "PUBLICATION_CLAIMED", r.site, r.request.ID)
	})
	return claim, e
}

func (s *Store) DecidePublication(ctx context.Context, site, jobID string, raw []byte) (map[string]any, PublicationDelivery, error) {
	var delivery PublicationDelivery
	if e := s.validator.Check("PublicationDecision", raw); e != nil {
		return nil, delivery, e
	}
	var dec struct {
		ArtifactID     string   `json:"artifactId"`
		Fence          Fence    `json:"fence"`
		ManifestSHA256 string   `json:"manifestSha256"`
		Decision       string   `json:"decision"`
		PublicationID  string   `json:"publicationId"`
		ClaimID        string   `json:"claimId"`
		Error          *APIError `json:"error"`
	}
	_ = json.Unmarshal(raw, &dec)
	ack := map[string]any{"protocolVersion": "2.0", "artifactId": dec.ArtifactID, "applied": true}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := loadJob(tx, site, jobID)
		if e != nil {
			return e
		}
		var claimID string
		var stored []byte
		var prev []byte
		e = tx.QueryRow("SELECT claim_id,claim,decision FROM publications WHERE job_seq=?", r.seq).Scan(&claimID, &stored, &prev)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(409, "INVALID_TRANSITION", "Publication claim is required first")
		}
		if e != nil {
			return e
		}
		if claimID != dec.ClaimID {
			return problem(409, "IDEMPOTENCY_CONFLICT", "Decision claim does not match")
		}
		if len(prev) > 0 {
			if digest(prev) != digest(raw) {
				return problem(409, "IDEMPOTENCY_CONFLICT", "Publication decision content changed")
			}
			return nil
		}
		if r.view.Status != "PUBLISHING" || r.view.Artifact == nil {
			return problem(409, "INVALID_TRANSITION", "Decision is out of order")
		}
		if r.view.Artifact.ID != dec.ArtifactID || r.view.Artifact.ManifestSHA256 != dec.ManifestSHA256 || !fenceEqual(r.view.Artifact.Fence, dec.Fence) {
			return problem(409, "STALE_ASSIGNMENT", "Decision does not match the claimed artifact")
		}
		now := s.now()
		status := "FAILED"
		if dec.Decision == "PUBLISHED" {
			status = publicationStatus(r.view.Artifact.Manifest.Steps)
			r.view.Error = nil
			if status == "PARTIAL" {
				r.view.ManualEntryOffered = true
			}
		} else {
			r.view.Error = dec.Error
			if r.view.Error != nil {
				r.view.Error.Permanent = true
			}
			r.view.ManualEntryOffered = r.request.Type != "media.transcode"
		}
		r.view.Status = status
		r.view.Actionable = false
		r.view.Stage = ""
		if _, e = tx.Exec("UPDATE publications SET decision=?,delivered=0 WHERE job_seq=?", raw, r.seq); e != nil {
			return e
		}
		device := ""
		_ = tx.QueryRow("SELECT device_id FROM transfers WHERE job_seq=? AND assignment_id=? LIMIT 1", r.seq, dec.Fence.AssignmentID).Scan(&device)
		delivery = PublicationDelivery{device, r.request.ID, dec.Fence, dec.ArtifactID, status}
		if e = saveJob(tx, &r, now); e != nil {
			return e
		}
		return audit(tx, now.UnixMilli(), "JOB_"+status, r.site, r.request.ID)
	})
	return ack, delivery, e
}

func (s *Store) PendingGrants(ctx context.Context, p Principal, session string) ([]GrantDelivery, error) {
	var out []GrantDelivery
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		rows, e := tx.Query(`SELECT t.device_id,t.kind,j.id,t.assignment_id,t.generation,t.epoch,p.links,p.request_id,p.page
 FROM transfer_pages p JOIN transfers t ON t.id=p.request_id JOIN jobs j ON j.seq=t.job_seq
 WHERE t.device_id=? AND t.status='OPEN' AND p.delivered=0`, p.ID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var d GrantDelivery
			var raw []byte
			if e = rows.Scan(&d.DeviceID, &d.Kind, &d.JobID, &d.Fence.AssignmentID, &d.Fence.Generation, &d.Fence.DispatcherEpoch, &raw, new(string), new(int)); e != nil {
				return e
			}
			if json.Unmarshal(raw, &d.Grant) != nil {
				return problem(500, "INTERNAL_ERROR", "Stored grant is unreadable")
			}
			out = append(out, d)
		}
		return rows.Err()
	})
	return out, e
}

func (s *Store) MarkGrantDelivered(ctx context.Context, requestID string, page int) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec("UPDATE transfer_pages SET delivered=1 WHERE request_id=? AND page=?", requestID, page)
		return e
	})
}

func (s *Store) PendingPublication(ctx context.Context, p Principal, session string) ([]PublicationDelivery, error) {
	var out []PublicationDelivery
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		rows, e := tx.Query(`SELECT t.device_id,j.id,t.assignment_id,t.generation,t.epoch,j.view,p.delivered
 FROM publications p JOIN jobs j ON j.seq=p.job_seq JOIN transfers t ON t.job_seq=j.seq AND t.kind='UPLOAD'
 WHERE t.device_id=? AND p.delivered=0 AND j.status IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','RELEASED')`, p.ID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var d PublicationDelivery
			var view []byte
			var delivered int
			if e = rows.Scan(&d.DeviceID, &d.JobID, &d.Fence.AssignmentID, &d.Fence.Generation, &d.Fence.DispatcherEpoch, &view, &delivered); e != nil {
				return e
			}
			var v JobView
			if json.Unmarshal(view, &v) != nil || v.Artifact == nil {
				continue
			}
			d.ArtifactID = v.Artifact.ID
			d.Outcome = v.Status
			if v.Status == "CANCELLED" || v.Status == "RELEASED" {
				continue
			}
			out = append(out, d)
		}
		return rows.Err()
	})
	return out, e
}

func (s *Store) MarkPublicationDelivered(ctx context.Context, jobID, device string) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec("UPDATE publications SET delivered=1 WHERE job_seq=(SELECT seq FROM jobs WHERE id=?) AND EXISTS (SELECT 1 FROM transfers WHERE job_seq=publications.job_seq AND device_id=?)", jobID, device)
		return e
	})
}

func (s *Store) ReconcileActive(ctx context.Context, p Principal, session string, f Fence, jobID string) (keep bool, outcome string, artifactID string, err error) {
	err = s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		var state, device string
		var until int64
		e := tx.QueryRow("SELECT state,device_id,lease_until FROM assignments WHERE id=? AND generation=? AND epoch=?", f.AssignmentID, f.Generation, f.DispatcherEpoch).Scan(&state, &device, &until)
		if errors.Is(e, sql.ErrNoRows) || device != p.ID {
			return nil
		}
		if e != nil {
			return e
		}
		var id, status string
		var view []byte
		if e = tx.QueryRow("SELECT j.id,j.status,j.view FROM assignments a JOIN jobs j ON j.seq=a.job_seq WHERE a.id=?", f.AssignmentID).Scan(&id, &status, &view); e != nil {
			return e
		}
		if id != jobID {
			return nil
		}
		if state == "RUNNING" {
			keep = until > s.now().UnixMilli()
			return nil
		}
		if status == "AWAITING_PUBLICATION" || status == "PUBLISHING" {
			keep = true
			return nil
		}
		if status == "SUCCEEDED" || status == "PARTIAL" || status == "FAILED" {
			var v JobView
			_ = json.Unmarshal(view, &v)
			keep = true
			outcome = status
			if v.Artifact != nil {
				artifactID = v.Artifact.ID
			}
		}
		return nil
	})
	return keep, outcome, artifactID, err
}

func validateManifest(req JobRequest, art Artifact) error {
	paths := map[string]bool{}
	for _, f := range art.Manifest.Files {
		if paths[f.Path] {
			return problem(400, "INVALID_REQUEST", "Artifact paths must be unique")
		}
		paths[f.Path] = true
	}
	if req.Type == "media.transcode" {
		if art.Manifest.MasterPath == "" || len(art.Manifest.Renditions) == 0 {
			return problem(400, "INVALID_REQUEST", "Transcode artifacts need a master playlist and renditions")
		}
		if !paths[art.Manifest.MasterPath] {
			return problem(400, "INVALID_REQUEST", "Master playlist is missing from files")
		}
		videoOK := false
		for _, step := range art.Manifest.Steps {
			if step.Name == "video" && step.Status == "SUCCEEDED" {
				videoOK = true
			}
			if step.Status == "SUCCEEDED" && step.Error != nil || step.Status == "FAILED" && step.Error == nil {
				return problem(400, "INVALID_REQUEST", "Step status and error are inconsistent")
			}
		}
		if !videoOK {
			return problem(400, "INVALID_REQUEST", "Primary video step must succeed")
		}
		for _, rend := range art.Manifest.Renditions {
			if !paths[rend.Playlist] {
				return problem(400, "INVALID_REQUEST", "Rendition playlist is missing")
			}
			if rend.Mode != "COPY" && rend.Mode != "ENCODE" {
				return problem(400, "INVALID_REQUEST", "Unknown packaging mode")
			}
		}
		if e := validateSubtitleFiles(art, paths); e != nil {
			return e
		}
	}
	if req.Type == "media.transcribe" {
		found := false
		for _, f := range art.Manifest.Files {
			if f.Kind == "TRANSCRIPT" {
				found = true
			}
		}
		if !found {
			return problem(400, "INVALID_REQUEST", "Transcribe artifacts need a transcript file")
		}
		ok := false
		for _, step := range art.Manifest.Steps {
			if step.Name == "transcript" && step.Status == "SUCCEEDED" {
				ok = true
			}
			if step.Status == "SUCCEEDED" && step.Error != nil || step.Status == "FAILED" && step.Error == nil {
				return problem(400, "INVALID_REQUEST", "Step status and error are inconsistent")
			}
		}
		if !ok {
			return problem(400, "INVALID_REQUEST", "Transcript step must succeed")
		}
	}
	if req.Type == "media.subtitles" {
		ok := false
		for _, step := range art.Manifest.Steps {
			if (step.Name == "subtitles" || step.Name == "transcript") && step.Status == "SUCCEEDED" {
				ok = true
			}
			if step.Status == "SUCCEEDED" && step.Error != nil || step.Status == "FAILED" && step.Error == nil {
				return problem(400, "INVALID_REQUEST", "Step status and error are inconsistent")
			}
		}
		if !ok {
			return problem(400, "INVALID_REQUEST", "At least one subtitle or transcript step must succeed")
		}
		if e := validateSubtitleFiles(art, paths); e != nil {
			return e
		}
	}
	return nil
}

func validateSubtitleFiles(art Artifact, paths map[string]bool) error {
	for _, step := range art.Manifest.Steps {
		if step.Name != "subtitles" || step.Status != "SUCCEEDED" {
			continue
		}
		found := false
		for _, f := range art.Manifest.Files {
			if f.Kind == "SUBTITLE" && f.Language == step.Language {
				found = true
			}
		}
		if !found || step.Language == "" {
			return problem(400, "INVALID_REQUEST", "Successful subtitle steps need a matching subtitle file")
		}
	}
	_ = paths
	return nil
}

func requiredPaths(files []ArtifactFile) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, f.Path)
	}
	sort.Strings(out)
	return out
}

func requiredGrant(r jobRow, kind string, artifact []byte, fence Fence) ([]string, string, error) {
	if kind == "SOURCE" {
		if r.request.Source.Kind == "HLS" {
			paths := make([]string, 0, len(r.request.Source.Files))
			for _, part := range r.request.Source.Files {
				paths = append(paths, part.Path)
			}
			sort.Strings(paths)
			return paths, "GET", nil
		}
		return []string{"source"}, "GET", nil
	}
	var art Artifact
	if json.Unmarshal(artifact, &art) != nil {
		return nil, "", problem(500, "INTERNAL_ERROR", "Stored artifact is unreadable")
	}
	if !fenceEqual(art.Fence, fence) {
		return nil, "", problem(409, "STALE_ASSIGNMENT", "Upload grant fence mismatch")
	}
	return requiredPaths(art.Manifest.Files), "PUT", nil
}

func validateLinks(grant TransferGrant, required []string, method, site, job string, f Fence, kind string, req JobRequest) error {
	seen := map[string]bool{}
	prefix := "jobs/" + site + "/" + job + "/" + f.DispatcherEpoch + "/" + formatGeneration(f.Generation) + "/" + f.AssignmentID + "/"
	for _, link := range grant.Links {
		if seen[link.Path] {
			return problem(400, "INVALID_REQUEST", "Grant paths must be unique")
		}
		seen[link.Path] = true
		if link.Method != method {
			return problem(400, "INVALID_REQUEST", "Grant method does not match the transfer")
		}
		if kind == "SOURCE" && req.Source.Kind != "HLS" {
			if link.Path != "source" || link.ObjectName != req.Source.ObjectName {
				return problem(400, "INVALID_REQUEST", "Source grant must use path source and the declared object")
			}
		}
		if kind == "SOURCE" && req.Source.Kind == "HLS" {
			ok := false
			for _, part := range req.Source.Files {
				if part.Path == link.Path && part.ObjectName == link.ObjectName {
					ok = true
				}
			}
			if !ok {
				return problem(400, "INVALID_REQUEST", "HLS grant paths must match the declared source parts")
			}
		}
		if kind == "UPLOAD" {
			if !strings.HasPrefix(link.ObjectName, prefix) || !strings.HasSuffix(link.ObjectName, "/"+link.Path) && link.ObjectName != prefix+link.Path {
				return problem(400, "INVALID_REQUEST", "Upload objects must be isolated under the attempt prefix")
			}
			if link.ObjectName != prefix+link.Path {
				return problem(400, "INVALID_REQUEST", "Upload objectName must be prefix plus relative path")
			}
		}
		if e := checkLinkURL(link); e != nil {
			return e
		}
	}
	if grant.LastPage {
		for _, path := range required {
			if !seen[path] {
				// later pages may already exist; completeness checked separately
				_ = path
			}
		}
	}
	return nil
}

func checkLinkURL(link Link) error {
	if len(link.URL) > 16*1024 {
		return problem(400, "INVALID_REQUEST", "URL exceeds the metadata limit")
	}
	u, e := url.Parse(link.URL)
	if e != nil || u.User != nil || u.Host == "" {
		return problem(400, "INVALID_REQUEST", "Grant URL is invalid")
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme == "http" {
		if host != "127.0.0.1" && host != "localhost" && host != "::1" {
			return problem(400, "INVALID_REQUEST", "Non-local grant URLs must use TLS")
		}
	} else if u.Scheme != "https" {
		return problem(400, "INVALID_REQUEST", "Unsupported grant URL scheme")
	}
	for name := range link.Headers {
		n := strings.ToLower(name)
		if n == "authorization" || n == "cookie" || n == "set-cookie" || n == "proxy-authorization" {
			return problem(400, "INVALID_REQUEST", "Grant headers cannot carry cookies or authorization")
		}
	}
	return nil
}

func mappingFingerprint(links []Link) string {
	type part struct {
		Path, ObjectName, Method string
	}
	items := make([]part, 0, len(links))
	for _, l := range links {
		items = append(items, part{l.Path, l.ObjectName, l.Method})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Path < items[j].Path })
	canonical, _ := canonicalTransform(encode(items))
	return digest(canonical)
}

func requireCompleteGrant(tx *sql.Tx, requestID string, required []string) error {
	rows, e := tx.Query("SELECT page,last_page,links FROM transfer_pages WHERE request_id=?", requestID)
	if e != nil {
		return e
	}
	defer rows.Close()
	seen := map[string]bool{}
	last := false
	pages := map[int]bool{}
	max := -1
	for rows.Next() {
		var page, lastPage int
		var raw []byte
		if e = rows.Scan(&page, &lastPage, &raw); e != nil {
			return e
		}
		pages[page] = true
		if page > max {
			max = page
		}
		if lastPage == 1 {
			last = true
		}
		var grant TransferGrant
		if json.Unmarshal(raw, &grant) != nil {
			return problem(500, "INTERNAL_ERROR", "Stored grant is unreadable")
		}
		for _, link := range grant.Links {
			seen[link.Path] = true
		}
	}
	if e = rows.Err(); e != nil {
		return e
	}
	if !last {
		return problem(409, "INCOMPLETE_GRANT", "Last grant page is required before commit")
	}
	for i := 0; i <= max; i++ {
		if !pages[i] {
			return problem(409, "INCOMPLETE_GRANT", "Grant pages must be contiguous")
		}
	}
	if len(seen) != len(required) {
		return problem(409, "INCOMPLETE_GRANT", "Grant does not cover the declared objects")
	}
	for _, path := range required {
		if !seen[path] {
			return problem(409, "INCOMPLETE_GRANT", "Grant is missing a declared path")
		}
	}
	return nil
}

func publicationStatus(steps []Step) string {
	failed := false
	for _, step := range steps {
		if step.Status == "FAILED" || step.Status == "SKIPPED" {
			failed = true
		}
	}
	if failed {
		return "PARTIAL"
	}
	return "SUCCEEDED"
}

func cancelTransfers(tx *sql.Tx, seq int64) error {
	_, e := tx.Exec("UPDATE transfers SET status='CANCELLED' WHERE job_seq=? AND status='OPEN'", seq)
	return e
}
