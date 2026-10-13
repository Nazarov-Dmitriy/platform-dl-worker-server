package dispatcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"titunki/worker-server/contracts"
)

// Languages are taken from the OpenAI Whisper multilingual tokenizer, not a site locale list.
// https://github.com/openai/whisper/blob/main/whisper/tokenizer.py
var whisperLanguages = []string{
	"en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv",
	"it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no",
	"th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr",
	"az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
	"gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu",
	"am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl",
	"mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue",
}

// Base and small precede large-v3 and support 99 languages (no Cantonese token).
func baseWhisperLanguages() []string {
	out := []string{}
	for _, language := range whisperLanguages {
		if language != "yue" {
			out = append(out, language)
		}
	}
	return out
}

func pinnedCatalog() []ModelEntry {
	osAll := []string{"windows", "darwin", "linux"}
	arch := []string{"amd64", "arm64"}
	acc := []string{"cpu", "cuda", "metal"}
	models := []ModelEntry{
		{
			ID: "whisper-cpp-base", Revision: "ggml-base-hf-5359861", Executor: "whisper.cpp",
			Purpose: "RECOGNITION", OS: osAll, Architectures: arch, Accelerators: acc,
			RecognitionLanguages: baseWhisperLanguages(), TranslationDirections: []Pair{},
			DownloadBytes: 147951465, MinimumRAMBytes: 1 << 30, MinimumVRAMBytes: 0,
			SHA256:      "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
			DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",
			License:     "MIT", DescriptionSource: "https://github.com/openai/whisper/blob/main/whisper/tokenizer.py",
		},
		{
			ID: "whisper-cpp-small", Revision: "ggml-small-hf-5359861", Executor: "whisper.cpp",
			Purpose: "RECOGNITION", OS: osAll, Architectures: arch, Accelerators: acc,
			RecognitionLanguages: baseWhisperLanguages(), TranslationDirections: []Pair{},
			DownloadBytes: 487601967, MinimumRAMBytes: 2 << 30, MinimumVRAMBytes: 0,
			SHA256:      "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
			DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
			License:     "MIT", DescriptionSource: "https://github.com/openai/whisper/blob/main/whisper/tokenizer.py",
		},
	}
	raw, err := contracts.Files.ReadFile("translation-catalog.json")
	if err != nil {
		panic(err)
	}
	var translations []ModelEntry
	if err = json.Unmarshal(raw, &translations); err != nil {
		panic(err)
	}
	return append(models, translations...)
}

func (s *Store) seedCatalog() error {
	for _, old := range []struct{ id, revision, hash string }{
		{"whisper-cpp-base", "ggml-base-v1.7.6", "60ed5e3d76e1a12f3e9afd536d6518c733dc74fa9284c3a77df5adc76cc47e27"},
		{"whisper-cpp-small", "ggml-small-v1.7.6", "1be3a9b2063867b937e64e2ec7483364a152123cbd738e99835de1eb5394d21a"},
	} {
		if _, e := s.db.Exec("DELETE FROM model_catalog WHERE id=? AND revision=? AND json_extract(entry, '$.sha256')=?", old.id, old.revision, old.hash); e != nil {
			return e
		}
	}

	if _, e := s.db.Exec("DELETE FROM model_catalog WHERE id=? AND revision=? AND json_extract(entry, '$.sha256')=?", "nllb-200-distilled-600m-int8", "ct2-2024-01", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); e != nil {
		return e
	}
	for _, m := range pinnedCatalog() {
		if e := s.validator.Check("ModelEntry", encode(m)); e != nil {
			return e
		}
		if _, e := s.db.Exec("INSERT OR IGNORE INTO model_catalog(id,revision,entry) VALUES(?,?,?)", m.ID, m.Revision, encode(m)); e != nil {
			return e
		}
	}
	return nil
}

func (s *Store) ImportCatalog(ctx context.Context, raw []byte) error {
	var items []ModelEntry
	if json.Unmarshal(raw, &items) != nil || len(items) == 0 {
		return problem(400, "INVALID_CATALOG", "Catalog import needs a ModelEntry array")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		for _, m := range items {
			if e := s.validator.Check("ModelEntry", encode(m)); e != nil {
				return e
			}
			if _, e := tx.Exec("INSERT OR REPLACE INTO model_catalog(id,revision,entry) VALUES(?,?,?)", m.ID, m.Revision, encode(m)); e != nil {
				return e
			}
		}
		return audit(tx, s.now().UnixMilli(), "CATALOG_IMPORTED", "", "")
	})
}

func (s *Store) Models(ctx context.Context) ([]ModelEntry, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT entry FROM model_catalog ORDER BY id,revision")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []ModelEntry{}
	for rows.Next() {
		var raw []byte
		var m ModelEntry
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		if e = json.Unmarshal(raw, &m); e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) EnqueueCommand(ctx context.Context, device string, raw []byte) (CommandView, error) {
	var view CommandView
	if e := s.validator.Check("AdminCommand", raw); e != nil {
		return view, e
	}
	var cmd AdminCommand
	if json.Unmarshal(raw, &cmd) != nil {
		return view, problem(400, "INVALID_REQUEST", "Invalid device command")
	}
	canonical, e := canonicalTransform(raw)
	if e != nil {
		return view, e
	}
	fp := digest(canonical)
	e = s.transaction(ctx, func(tx *sql.Tx) error {
		var n int
		if e := tx.QueryRow("SELECT count(*) FROM devices WHERE id=? AND enabled=1", device).Scan(&n); e != nil {
			return e
		}
		if n == 0 {
			return problem(404, "NOT_FOUND", "Device not found")
		}
		var oldFP, status string
		var progress sql.NullFloat64
		var errRaw []byte
		e = tx.QueryRow("SELECT fingerprint,status,progress,error FROM device_commands WHERE request_id=?", cmd.RequestID).Scan(&oldFP, &status, &progress, &errRaw)
		if e == nil {
			if oldFP != fp {
				return problem(409, "IDEMPOTENCY_CONFLICT", "Command request ID content changed")
			}
			view = CommandView{cmd.RequestID, status, nil, nil}
			if progress.Valid {
				v := progress.Float64
				view.Progress = &v
			}
			if len(errRaw) > 0 {
				_ = json.Unmarshal(errRaw, &view.Error)
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		if cmd.Type == "MODEL_INSTALL" || cmd.Type == "MODEL_ACTIVATE" || cmd.Type == "MODEL_DELETE" {
			var entry []byte
			if e = tx.QueryRow("SELECT entry FROM model_catalog WHERE id=? AND revision=?", cmd.ModelID, cmd.ModelRevision).Scan(&entry); errors.Is(e, sql.ErrNoRows) {
				return problem(404, "NOT_FOUND", "Model revision is not in the catalog")
			} else if e != nil {
				return e
			}
		}
		if cmd.Type == "MODEL_DELETE" {
			var active int
			if e = tx.QueryRow("SELECT count(*) FROM assignments a JOIN jobs j ON j.seq=a.job_seq WHERE a.device_id=? AND a.state IN ('OFFERED','RUNNING','CANCELLING','RELEASING')", device).Scan(&active); e != nil {
				return e
			}
			if active > 0 {
				return problem(409, "MODEL_IN_USE", "Cannot delete a model while the device has an active assignment")
			}
		}
		if cmd.Type == "CONFIGURE" && len(cmd.Settings) > 0 {
			if _, e = tx.Exec(`INSERT INTO device_identity(device_id,desired_settings) VALUES(?,?)
 ON CONFLICT(device_id) DO UPDATE SET desired_settings=excluded.desired_settings`, device, string(cmd.Settings)); e != nil {
				return e
			}
		}
		if _, e = tx.Exec("INSERT INTO device_commands(request_id,device_id,fingerprint,body,status,created_at) VALUES(?,?,?,?,'PENDING',?)", cmd.RequestID, device, fp, canonical, s.now().UnixMilli()); e != nil {
			return e
		}
		view = CommandView{cmd.RequestID, "PENDING", nil, nil}
		return audit(tx, s.now().UnixMilli(), "COMMAND_ENQUEUED", device, cmd.RequestID)
	})
	return view, e
}

func (s *Store) Command(ctx context.Context, requestID string) (CommandView, error) {
	var view CommandView
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var progress sql.NullFloat64
		var errRaw []byte
		e := tx.QueryRow("SELECT request_id,status,progress,error FROM device_commands WHERE request_id=?", requestID).Scan(&view.RequestID, &view.Status, &progress, &errRaw)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Command not found")
		}
		if e != nil {
			return e
		}
		if progress.Valid {
			v := progress.Float64
			view.Progress = &v
		}
		if len(errRaw) > 0 {
			_ = json.Unmarshal(errRaw, &view.Error)
		}
		return nil
	})
	return view, e
}

func (s *Store) PendingCommands(ctx context.Context, p Principal, session string) ([]json.RawMessage, error) {
	var out []json.RawMessage
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		rows, e := tx.Query("SELECT body FROM device_commands WHERE device_id=? AND status='PENDING' AND notified=0 ORDER BY created_at", p.ID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var raw []byte
			if e = rows.Scan(&raw); e != nil {
				return e
			}
			out = append(out, raw)
		}
		return rows.Err()
	})
	return out, e
}

func (s *Store) MarkCommandsNotified(ctx context.Context, p Principal, session string, bodies []json.RawMessage) error {
	if len(bodies) == 0 {
		return nil
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		for _, raw := range bodies {
			var cmd AdminCommand
			if json.Unmarshal(raw, &cmd) != nil {
				continue
			}
			if _, e := tx.Exec("UPDATE device_commands SET notified=1 WHERE request_id=? AND device_id=? AND status='PENDING'", cmd.RequestID, p.ID); e != nil {
				return e
			}
		}
		return nil
	})
}

func (s *Store) CommandResult(ctx context.Context, p Principal, session, requestID, status string, progress *float64, cause *APIError) error {
	if !contains([]string{"RUNNING", "SUCCEEDED", "FAILED"}, status) {
		return problem(400, "INVALID_REQUEST", "Unknown command status")
	}
	if status == "FAILED" && (cause == nil || s.validator.Check("Error", encode(*cause)) != nil) {
		return problem(400, "INVALID_REQUEST", "Failed command needs an error")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		if e := checkDevice(tx, p, session); e != nil {
			return e
		}
		var body []byte
		var current string
		e := tx.QueryRow("SELECT body,status FROM device_commands WHERE request_id=? AND device_id=?", requestID, p.ID).Scan(&body, &current)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Command not found")
		}
		if e != nil {
			return e
		}
		if current == "SUCCEEDED" || current == "FAILED" {
			if current == status {
				return nil
			}
			return problem(409, "INVALID_TRANSITION", "Command already finished")
		}
		var errRaw []byte
		if cause != nil {
			errRaw = encode(*cause)
		}
		if _, e = tx.Exec("UPDATE device_commands SET status=?,progress=?,error=? WHERE request_id=?", status, progress, errRaw, requestID); e != nil {
			return e
		}
		if status != "SUCCEEDED" {
			return nil
		}
		var cmd AdminCommand
		if json.Unmarshal(body, &cmd) != nil {
			return nil
		}
		switch cmd.Type {
		case "MODEL_INSTALL":
			_, e = tx.Exec("INSERT OR IGNORE INTO device_models(device_id,model_id,revision,state) VALUES(?,?,?,'INSTALLED')", p.ID, cmd.ModelID, cmd.ModelRevision)
		case "MODEL_ACTIVATE":
			_, e = tx.Exec("INSERT OR REPLACE INTO device_models(device_id,model_id,revision,state) VALUES(?,?,?,'ACTIVE')", p.ID, cmd.ModelID, cmd.ModelRevision)
		case "MODEL_DELETE":
			_, e = tx.Exec("DELETE FROM device_models WHERE device_id=? AND model_id=? AND revision=?", p.ID, cmd.ModelID, cmd.ModelRevision)
		case "CONFIGURE":
			if len(cmd.Settings) > 0 {
				_, e = tx.Exec(`INSERT INTO device_identity(device_id,reported_settings) VALUES(?,?)
 ON CONFLICT(device_id) DO UPDATE SET reported_settings=excluded.reported_settings`, p.ID, string(cmd.Settings))
			}
		}
		return e
	})
}

func (s *Store) CatalogEntry(id, revision string) (ModelEntry, error) {
	var m ModelEntry
	var raw []byte
	e := s.db.QueryRow("SELECT entry FROM model_catalog WHERE id=? AND revision=?", id, revision).Scan(&raw)
	if errors.Is(e, sql.ErrNoRows) {
		return m, problem(404, "NOT_FOUND", "Model revision is not in the catalog")
	}
	if e != nil {
		return m, e
	}
	return m, json.Unmarshal(raw, &m)
}
