package dispatcher

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBaseCatalogUsesWhisperTokenizerLanguages(t *testing.T) {
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

func TestAdminModelsReportsPlacements(t *testing.T) {
	s, _, _ := openTest(t)
	p, session := testDevice(t, s)
	entry := ModelEntry{
		ID: "catalog-test-placed", Revision: "test-1", Executor: "catalog-test",
		Purpose: "RECOGNITION", OS: []string{"windows", "darwin", "linux"},
		Architectures: []string{"amd64", "arm64"}, Accelerators: []string{"cpu"},
		RecognitionLanguages: []string{"en"}, TranslationDirections: []Pair{},
		DownloadBytes: 12, MinimumRAMBytes: 1, MinimumVRAMBytes: 0,
		SHA256:      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		DownloadURL: "http://127.0.0.1:9/speech.json", License: "MIT",
		DescriptionSource: "http://127.0.0.1:9/speech.json",
	}
	if e := s.ImportCatalog(testContext, encode([]ModelEntry{entry})); e != nil {
		t.Fatal(e)
	}
	// Nothing is installed yet, so the fleet catalog carries an empty list
	// rather than omitting the field.
	page, e := s.AdminModels(testContext, "")
	if e != nil {
		t.Fatal(e)
	}
	placed, ok := page["placements"].([]ModelPlacement)
	if !ok || len(placed) != 0 {
		t.Fatalf("placements before install: %#v", page["placements"])
	}
	// A per-device listing stays a compatibility filter and omits the field.
	if one, e := s.AdminModels(testContext, p.ID); e != nil {
		t.Fatal(e)
	} else if _, present := one["placements"]; present {
		t.Fatal("per-device listing must not carry placements")
	}
	run := func(kind string) {
		t.Helper()
		cmd := AdminCommand{RequestID: UUID(), Type: kind, ModelID: entry.ID, ModelRevision: entry.Revision}
		if _, e := s.EnqueueCommand(testContext, p.ID, encode(cmd)); e != nil {
			t.Fatal(e)
		}
		pending, e := s.PendingCommands(testContext, p, session)
		if e != nil {
			t.Fatal(e)
		}
		if e = s.MarkCommandsNotified(testContext, p, session, pending); e != nil {
			t.Fatal(e)
		}
		if e = s.CommandResult(testContext, p, session, cmd.RequestID, "SUCCEEDED", nil, nil); e != nil {
			t.Fatal(e)
		}
	}
	run("MODEL_INSTALL")
	page, e = s.AdminModels(testContext, "")
	if e != nil {
		t.Fatal(e)
	}
	placed = page["placements"].([]ModelPlacement)
	if len(placed) != 1 || placed[0].State != "INSTALLED" ||
		placed[0].DeviceID != p.ID || placed[0].ModelID != entry.ID ||
		placed[0].Revision != entry.Revision {
		t.Fatalf("after install: %#v", placed)
	}
	run("MODEL_ACTIVATE")
	page, e = s.AdminModels(testContext, "")
	if e != nil {
		t.Fatal(e)
	}
	placed = page["placements"].([]ModelPlacement)
	if len(placed) != 1 || placed[0].State != "ACTIVE" {
		t.Fatalf("after activate: %#v", placed)
	}
	run("MODEL_DELETE")
	page, e = s.AdminModels(testContext, "")
	if e != nil {
		t.Fatal(e)
	}
	if placed = page["placements"].([]ModelPlacement); len(placed) != 0 {
		t.Fatalf("after delete: %#v", placed)
	}
}

// A device must be told what it may install; it used to read a file placed
// beside it at build time, which the site could not reach.
func TestDeviceReceivesCatalogOnConnect(t *testing.T) {
	s, _, _ := openTest(t)
	s.now = time.Now
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
	frame := wsRead(t, c, "catalog.offer")
	var body struct {
		Models []ModelEntry `json:"models"`
	}
	if e = json.Unmarshal(frame.Body, &body); e != nil {
		t.Fatal(e)
	}
	catalog, e := s.Models(testContext)
	if e != nil {
		t.Fatal(e)
	}
	if len(body.Models) != len(catalog) || len(body.Models) == 0 {
		t.Fatalf("offered %d of %d models", len(body.Models), len(catalog))
	}
	for _, m := range body.Models {
		if m.DownloadURL == "" || m.SHA256 == "" {
			t.Fatalf("%s arrived without a way to fetch or verify it", m.ID)
		}
	}
	// An edit on the site reaches the device without a reconnect.
	owner := AdminActor{ID: "owner", Role: "OWNER"}
	if e = s.AdminDeleteModel(testContext, owner, body.Models[0].ID, body.Models[0].Revision); e != nil {
		t.Fatal(e)
	}
	h.BroadcastCatalog(testContext)
	frame = wsRead(t, c, "catalog.offer")
	if e = json.Unmarshal(frame.Body, &body); e != nil {
		t.Fatal(e)
	}
	if len(body.Models) != len(catalog)-1 {
		t.Fatalf("after removal the device still sees %d models", len(body.Models))
	}
}
