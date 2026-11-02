package dispatcher

import "testing"

func TestSeededCatalogIsRemovable(t *testing.T) {
	s, _, _ := openTest(t)
	owner := AdminActor{ID: "owner", Role: "OWNER"}
	models, e := s.Models(testContext)
	if e != nil || len(models) == 0 {
		t.Fatal(e, len(models))
	}
	// Nothing the build ships is protected: the catalog is a list an owner
	// edits, which is the whole reason it lives in a table.
	for _, m := range models {
		if len(m.Operations) == 0 {
			t.Fatalf("seeded model has no operations: %s", m.ID)
		}
		if e = s.AdminDeleteModel(testContext, owner, m.ID, m.Revision); e != nil {
			t.Fatalf("%s: %v", m.ID, e)
		}
	}
	// A removed entry stays removed when the dispatcher starts again.
	if e = s.seedCatalog(); e != nil {
		t.Fatal(e)
	}
	models, e = s.Models(testContext)
	if e != nil {
		t.Fatal(e)
	}
	if len(models) != 0 {
		t.Fatalf("seeding resurrected %d removed entries", len(models))
	}
	wantError(t, s.AdminDeleteModel(testContext, owner, "nothing", "x"), "NOT_FOUND")
}

// One multilingual model in place of a pair per direction, described by the
// files it is actually made of.
func TestNLLBEntryDescribesEveryDirection(t *testing.T) {
	entry := nllbEntry()
	if entry.Executor != "transformers-js" || entry.Purpose != "TRANSLATION" {
		t.Fatalf("%s %s", entry.Executor, entry.Purpose)
	}
	languages := len(nllbCodes)
	if want := languages * (languages - 1); len(entry.TranslationDirections) != want {
		t.Fatalf("%d directions, want %d", len(entry.TranslationDirections), want)
	}
	if len(entry.Files) != len(translationFiles) {
		t.Fatalf("%d files", len(entry.Files))
	}
	var total int64
	for _, f := range entry.Files {
		if !lfsObjectID.MatchString(f.SHA256) {
			t.Fatalf("%s has no digest", f.Path)
		}
		total += f.Bytes
	}
	if entry.DownloadBytes != total {
		t.Fatalf("%d bytes, files add up to %d", entry.DownloadBytes, total)
	}
	canonical, e := canonicalTransform(encode(entry.Files))
	if e != nil {
		t.Fatal(e)
	}
	if entry.SHA256 != digest(canonical) {
		t.Fatal("package digest does not describe its files")
	}
}

func TestCatalogEntryDeletedUnlessInstalled(t *testing.T) {
	s, _, _ := openTest(t)
	p, deviceSession := testDevice(t, s)
	owner := AdminActor{ID: "owner", Role: "OWNER"}
	entry := ModelEntry{
		ID: "catalog-test-removable", Revision: "test-1", Executor: "catalog-test",
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
	// An imported entry is not pinned, so it can be removed again.
	cmd := AdminCommand{RequestID: UUID(), Type: "MODEL_INSTALL", ModelID: entry.ID, ModelRevision: entry.Revision}
	if _, e := s.EnqueueCommand(testContext, p.ID, encode(cmd)); e != nil {
		t.Fatal(e)
	}
	pending, e := s.PendingCommands(testContext, p, deviceSession)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.MarkCommandsNotified(testContext, p, deviceSession, pending); e != nil {
		t.Fatal(e)
	}
	if e = s.CommandResult(testContext, p, deviceSession, cmd.RequestID, "SUCCEEDED", nil, nil); e != nil {
		t.Fatal(e)
	}
	// Removing it from the catalog while a device still holds it would leave
	// that device with a model nothing describes.
	wantError(t, s.AdminDeleteModel(testContext, owner, entry.ID, entry.Revision), "MODEL_IN_USE")
	remove := AdminCommand{RequestID: UUID(), Type: "MODEL_DELETE", ModelID: entry.ID, ModelRevision: entry.Revision}
	if _, e := s.EnqueueCommand(testContext, p.ID, encode(remove)); e != nil {
		t.Fatal(e)
	}
	pending, e = s.PendingCommands(testContext, p, deviceSession)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.MarkCommandsNotified(testContext, p, deviceSession, pending); e != nil {
		t.Fatal(e)
	}
	if e = s.CommandResult(testContext, p, deviceSession, remove.RequestID, "SUCCEEDED", nil, nil); e != nil {
		t.Fatal(e)
	}
	if e := s.AdminDeleteModel(testContext, owner, entry.ID, entry.Revision); e != nil {
		t.Fatal(e)
	}
	models, e := s.Models(testContext)
	if e != nil {
		t.Fatal(e)
	}
	for _, m := range models {
		if m.ID == entry.ID {
			t.Fatal("entry still in catalog")
		}
	}
}

// Rejected before any request leaves the dispatcher, so a malformed form never
// reaches huggingface.co.
func TestCatalogRequestValidatedBeforeFetch(t *testing.T) {
	s, _, _ := openTest(t)
	owner := AdminActor{ID: "owner", Role: "OWNER"}
	for _, req := range []CatalogRequest{
		{ID: "x", Repository: "not-a-repository", Revision: "main", Purpose: "RECOGNITION"},
		{ID: "x", Repository: "owner/name", Revision: "bad revision", Purpose: "RECOGNITION"},
		{ID: "", Repository: "owner/name", Revision: "main", Purpose: "RECOGNITION"},
		{ID: "x", Repository: "owner/name", Revision: "main", Purpose: "SOMETHING"},
		{ID: "x", Repository: "owner/name", Revision: "main", Purpose: "RECOGNITION", Operations: []string{"media.nope"}},
	} {
		if _, e := s.AdminAddModel(testContext, owner, encode(req)); e == nil {
			t.Fatalf("accepted %+v", req)
		}
	}
	operator := AdminActor{ID: "operator", Role: "OPERATOR"}
	if _, e := s.AdminAddModel(testContext, operator, encode(CatalogRequest{
		ID: "x", Repository: "owner/name", Revision: "main", Purpose: "RECOGNITION"})); e == nil {
		t.Fatal("operator may not change the catalog")
	}
}

func TestCatalogFileNeedsVerifiableDigest(t *testing.T) {
	tree := map[string]huggingFaceFile{
		"ggml-small.bin": {Type: "file", Path: "ggml-small.bin", Size: 487601967, LFS: &struct {
			OID  string `json:"oid"`
			Size int64  `json:"size"`
		}{OID: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", Size: 487601967}},
		"README.md": {Type: "file", Path: "README.md", Size: 3196},
	}
	file, e := describeCatalogFile(tree, "ggerganov/whisper.cpp", "5359861", "ggml-small.bin")
	if e != nil {
		t.Fatal(e)
	}
	if file.Bytes != 487601967 || file.SHA256 != "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" {
		t.Fatalf("%+v", file)
	}
	if file.URL != "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861/ggml-small.bin" {
		t.Fatal(file.URL)
	}
	// A plain git file carries no SHA-256, so it cannot back a catalog entry.
	if _, e = describeCatalogFile(tree, "ggerganov/whisper.cpp", "5359861", "README.md"); e == nil {
		t.Fatal("unverifiable file accepted")
	}
	if _, e = describeCatalogFile(tree, "ggerganov/whisper.cpp", "5359861", "missing.bin"); e == nil {
		t.Fatal("missing file accepted")
	}
}

func TestRoundRAMReportsWholeGigabytes(t *testing.T) {
	const gb = int64(1) << 30
	for _, c := range []struct{ in, want int64 }{
		{1, gb}, {gb, gb}, {gb + 1, 2 * gb}, {3 * gb, 3 * gb}, {3*gb + 1, 4 * gb},
	} {
		if got := roundRAM(c.in); got != c.want {
			t.Fatalf("roundRAM(%d)=%d want %d", c.in, got, c.want)
		}
	}
}

func TestModelOperationsDescribeLegacyEntries(t *testing.T) {
	if got := modelOperations(ModelEntry{Purpose: "RECOGNITION"}); len(got) != 2 ||
		!contains(got, "media.transcribe") || !contains(got, "media.subtitles") {
		t.Fatal(got)
	}
	if got := modelOperations(ModelEntry{Purpose: "TRANSLATION"}); len(got) != 1 || got[0] != "media.subtitles" {
		t.Fatal(got)
	}
	// An explicit choice is kept as the operator set it.
	stated := []string{"media.subtitles"}
	if got := modelOperations(ModelEntry{Purpose: "RECOGNITION", Operations: stated}); len(got) != 1 {
		t.Fatal(got)
	}
}
