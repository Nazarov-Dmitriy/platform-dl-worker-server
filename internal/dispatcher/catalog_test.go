package dispatcher

import (
	"encoding/json"
	"testing"
)

func TestPinnedCatalogUsesWhisperTokenizerLanguages(t *testing.T) {
	s, _, _ := openTest(t)
	models, e := s.Models(testContext)
	if e != nil {
		t.Fatal(e)
	}
	var rec ModelEntry
	for _, m := range models {
		if m.ID == "whisper-cpp-base" {
			rec = m
		}
		if m.Executor == "catalog-test" {
			t.Fatal("production catalog must not include catalog-test packs")
		}
	}
	if rec.ID == "" || rec.Purpose != "RECOGNITION" {
		t.Fatal(rec)
	}
	if len(rec.RecognitionLanguages) < 90 {
		t.Fatalf("whisper languages were truncated: %d", len(rec.RecognitionLanguages))
	}
	for _, lang := range []string{"uk", "th", "he", "sw"} {
		if !contains(rec.RecognitionLanguages, lang) {
			t.Fatalf("missing tokenizer language %s", lang)
		}
	}
	if contains(rec.RecognitionLanguages, "yue") {
		t.Fatal("base model has no Cantonese token")
	}
	if rec.DescriptionSource != "https://github.com/openai/whisper/blob/main/whisper/tokenizer.py" {
		t.Fatal(rec.DescriptionSource)
	}
}

func TestUnsupportedTranslationDirectionIsRejected(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	caps := []Capability{{
		Code: "media.subtitles", RecognitionLanguages: []string{"en"},
		TranslationDirections: []Pair{{"en", "ru"}}, AutoDetect: true,
		Formats: []string{"vtt"}, Availability: "ONLINE", ProfilePolicies: []string{},
	}}
	d, e := s.CreateDevice(testContext, "speech", caps)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.IssueToken(testContext, "DEVICE", d.ID); e != nil {
		t.Fatal(e)
	}
	var job map[string]any
	if e = json.Unmarshal(readFixture(t, "valid/job-subtitles.json").Value, &job); e != nil {
		t.Fatal(e)
	}
	job["id"] = UUID()
	job["params"] = map[string]any{
		"speech":          map[string]any{"sourceLanguage": "en", "mode": "FAST"},
		"includeOriginal": true,
		"targetLanguages": []string{"zh"},
		"formats":         []string{"vtt"},
	}
	v, created, e := s.Submit(testContext, site.ID, encode(job))
	if e != nil || created || v.Status != "REJECTED" || v.Error == nil || v.Error.Code != "OPERATION_UNAVAILABLE" || !v.ManualEntryOffered {
		t.Fatalf("%+v created=%v e=%v", v, created, e)
	}
}

func TestCatalogImportAndDeviceCommandQueue(t *testing.T) {
	s, _, _ := openTest(t)
	p, session := testDevice(t, s)
	entry := ModelEntry{
		ID: "catalog-test-speech", Revision: "test-1", Executor: "catalog-test",
		Purpose: "RECOGNITION", OS: []string{"windows", "darwin", "linux"},
		Architectures: []string{"amd64", "arm64"}, Accelerators: []string{"cpu"},
		RecognitionLanguages: []string{"en", "uk"}, TranslationDirections: []Pair{},
		DownloadBytes: 12, MinimumRAMBytes: 1, MinimumVRAMBytes: 0,
		SHA256:      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		DownloadURL: "http://127.0.0.1:9/speech.json", License: "MIT",
		DescriptionSource: "http://127.0.0.1:9/speech.json",
	}
	if e := s.ImportCatalog(testContext, encode([]ModelEntry{entry})); e != nil {
		t.Fatal(e)
	}
	cmd := AdminCommand{RequestID: UUID(), Type: "MODEL_INSTALL", ModelID: entry.ID, ModelRevision: entry.Revision}
	view, e := s.EnqueueCommand(testContext, p.ID, encode(cmd))
	if e != nil || view.Status != "PENDING" {
		t.Fatal(e, view)
	}
	again, e := s.EnqueueCommand(testContext, p.ID, encode(cmd))
	if e != nil || again.RequestID != view.RequestID {
		t.Fatal(e, again)
	}
	pending, e := s.PendingCommands(testContext, p, session)
	if e != nil || len(pending) != 1 {
		t.Fatal(e, len(pending))
	}
	if e = s.MarkCommandsNotified(testContext, p, session, pending); e != nil {
		t.Fatal(e)
	}
	empty, e := s.PendingCommands(testContext, p, session)
	if e != nil || len(empty) != 0 {
		t.Fatal(e, empty)
	}
	if e = s.CommandResult(testContext, p, session, cmd.RequestID, "SUCCEEDED", nil, nil); e != nil {
		t.Fatal(e)
	}
	got, e := s.Command(testContext, cmd.RequestID)
	if e != nil || got.Status != "SUCCEEDED" {
		t.Fatal(e, got)
	}
	unknown := AdminCommand{RequestID: UUID(), Type: "MODEL_INSTALL", ModelID: "missing", ModelRevision: "x"}
	if _, e = s.EnqueueCommand(testContext, p.ID, encode(unknown)); e == nil {
		t.Fatal("unknown model accepted")
	} else {
		wantError(t, e, "NOT_FOUND")
	}
}
