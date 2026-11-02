package dispatcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
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

// NLLB-200 translates between all of these in one model, which is why it
// replaces the pairwise opus-mt entries: six languages needed thirty of those.
// The value is the code NLLB itself uses; the key is the code the rest of the
// system speaks, so the worker has one place to look the mapping up.
var nllbCodes = map[string]string{
	"ru": "rus_Cyrl", "en": "eng_Latn", "de": "deu_Latn", "fr": "fra_Latn",
	"es": "spa_Latn", "it": "ita_Latn", "pt": "por_Latn", "nl": "nld_Latn",
	"pl": "pol_Latn", "cs": "ces_Latn", "tr": "tur_Latn", "uk": "ukr_Cyrl",
	"be": "bel_Cyrl", "kk": "kaz_Cyrl", "uz": "uzn_Latn", "az": "azj_Latn",
	"hy": "hye_Armn", "ka": "kat_Geor", "zh": "zho_Hans", "ja": "jpn_Jpan",
	"ko": "kor_Hang", "ar": "arb_Arab", "hi": "hin_Deva", "vi": "vie_Latn",
}

// Quantized transformers.js build of facebook/nllb-200-distilled-600M, read
// from the repository at a fixed commit so the files cannot shift underneath.
func nllbEntry() ModelEntry {
	const repository = "Xenova/nllb-200-distilled-600M"
	const revision = "261c31d1a5732c67cdd16d80e8d6088507c7ccea"
	weights := []struct {
		path   string
		bytes  int64
		sha256 string
	}{
		{"config.json", 873, "52f035acb54ac80e5ef7fe78d6967f8ddf8e8799f078d1a92a2c8168d8ff4a20"},
		{"generation_config.json", 189, "1ce846259ae04c572ae1863e358534bbc376ff3d3f100b1494feda6200b51de8"},
		{"tokenizer.json", 17331224, "8ac789ad7dabea44d41537822d48c516ba358374c51813e2cba78c006e150c94"},
		{"tokenizer_config.json", 544, "ddf411c9f790d081e72de76bb8e8b714d74e160e61bc10c9bd8f56022dcd7fd7"},
		{"onnx/encoder_model_quantized.onnx", 419120483, "5cde664eacba07a62f198857ec6c06e09572b1ebb77c8137f1fa99ac604a3a28"},
		{"onnx/decoder_model_merged_quantized.onnx", 475505771, "dd66608c2a4194e78f95548fa0e64f24302303698c5b09fa8e1f9e16ec00676b"},
	}
	files := []ModelFile{}
	var total int64
	for _, w := range weights {
		files = append(files, ModelFile{Path: w.path, Bytes: w.bytes, SHA256: w.sha256,
			URL: "https://huggingface.co/" + repository + "/resolve/" + revision + "/" + w.path})
		total += w.bytes
	}
	codes := []string{}
	for code := range nllbCodes {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	pairs := []Pair{}
	for _, source := range codes {
		for _, target := range codes {
			if source != target {
				pairs = append(pairs, Pair{Source: source, Target: target})
			}
		}
	}
	// The package digest is computed here rather than written down, so it can
	// never disagree with the files it is supposed to describe.
	canonical, e := canonicalTransform(encode(files))
	if e != nil {
		panic(e)
	}
	return ModelEntry{
		ID: "nllb-200-distilled-600m-q8", Revision: revision, Executor: "transformers-js",
		Purpose: "TRANSLATION", OS: []string{"windows", "darwin", "linux"},
		Architectures: []string{"amd64", "arm64"}, Accelerators: []string{"cpu"},
		RecognitionLanguages: []string{}, TranslationDirections: pairs, Files: files,
		DownloadBytes: total, MinimumRAMBytes: 4 << 30, MinimumVRAMBytes: 0,
		SHA256: digest(canonical), DownloadURL: "https://huggingface.co/" + repository,
		License: "CC-BY-NC-4.0", DescriptionSource: "https://huggingface.co/" + repository,
		Operations: []string{"media.subtitles"},
	}
}

func baseCatalog() []ModelEntry {
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
	return append(models, nllbEntry())
}

// Each entry the build ships is offered once. catalog_seeded remembers that it
// was offered, so an entry an operator removed stays removed, and an entry a
// later release adds still arrives without a migration carrying its JSON.
func (s *Store) seedCatalog() error {
	for _, m := range baseCatalog() {
		if e := s.validator.Check("ModelEntry", encode(m)); e != nil {
			return e
		}
		var seen int
		if e := s.db.QueryRow("SELECT count(*) FROM catalog_seeded WHERE id=?", m.ID).Scan(&seen); e != nil {
			return e
		}
		if seen > 0 {
			continue
		}
		if _, e := s.db.Exec("INSERT INTO model_catalog(id,revision,entry) VALUES(?,?,?)", m.ID, m.Revision, encode(m)); e != nil {
			return e
		}
		if _, e := s.db.Exec("INSERT INTO catalog_seeded(id) VALUES(?)", m.ID); e != nil {
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

// What a model is for, in the same vocabulary the panel and job requests use.
// Entries written before the field existed are described by their purpose.
func modelOperations(m ModelEntry) []string {
	if len(m.Operations) > 0 {
		return m.Operations
	}
	if m.Purpose == "RECOGNITION" {
		return []string{"media.transcribe", "media.subtitles"}
	}
	if m.Purpose == "TRANSLATION" {
		return []string{"media.subtitles"}
	}
	return []string{}
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
		m.Operations = modelOperations(m)
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
