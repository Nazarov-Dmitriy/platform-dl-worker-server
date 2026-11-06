package dispatcher

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func generationTestModel(id string) GenerationModel {
	return GenerationModel{ID: id, Revision: "weights-1", ProfileRevision: "profile-1", Name: id, Description: "Test model", AcceptsReference: false, Parameters: []GenerationParameter{
		{Key: "prompt", Label: "Prompt", Type: "string", Required: true, MaxLength: 4000},
		{Key: "width", Label: "Width", Type: "integer", Required: true, Options: []json.RawMessage{json.RawMessage(`512`), json.RawMessage(`1024`)}},
	}}
}
func generationTestCaps(m GenerationModel) []Capability {
	return []Capability{{Code: "media.generate", RecognitionLanguages: []string{}, TranslationDirections: []Pair{}, Formats: []string{"png"}, Availability: "ONLINE", ProfilePolicies: []string{}, GenerationModels: []GenerationModel{m}}}
}
func generationTestJob(m GenerationModel) JobRequest {
	return JobRequest{ProtocolVersion: "2.0", ID: UUID(), Type: "media.generate", Params: encode(map[string]any{"modelId": m.ID, "modelRevision": m.Revision, "profileRevision": m.ProfileRevision, "inputs": map[string]any{"prompt": "A forest", "width": 512}}), MaxOutputBytes: 1 << 20, MaxDurationSeconds: 60}
}
func TestGenerationModelsAreReadyDeduplicatedAndSiteScoped(t *testing.T) {
	s, _, _ := openTest(t)
	site, err := s.CreateSite(testContext, "generation", 1, []string{"media.generate"})
	if err != nil {
		t.Fatal(err)
	}
	m := generationTestModel("selected")
	first, firstSession := testDevice(t, s)
	second, secondSession := testDevice(t, s)
	for _, d := range []struct {
		p       Principal
		session string
	}{{first, firstSession}, {second, secondSession}} {
		if err = s.Heartbeat(testContext, d.p, d.session, generationTestCaps(m), testUsage()); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.GenerationModels(testContext, site.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(page["models"].([]GenerationModel)) != 1 {
		t.Fatal("same model must be listed once")
	}
	usage := testUsage()
	usage.Paused = true
	if err = s.Heartbeat(testContext, first, firstSession, generationTestCaps(m), usage); err != nil {
		t.Fatal(err)
	}
	if err = s.Heartbeat(testContext, second, secondSession, generationTestCaps(m), usage); err != nil {
		t.Fatal(err)
	}
	page, err = s.GenerationModels(testContext, site.ID)
	if err != nil || len(page["models"].([]GenerationModel)) != 0 {
		t.Fatal("paused devices must not advertise ready models", err)
	}
	other := testSite(t, s, 1)
	if _, err = s.GenerationModels(testContext, other.ID); err == nil {
		t.Fatal("site permission was not enforced")
	}
	_, token, err := s.IssueToken(testContext, "SITE", site.ID)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v2/site/generation/models", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	Handler(s).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if err = s.validator.Check("GenerationModelPage", rec.Body.Bytes()); err != nil {
		t.Fatal(err)
	}
}
func TestGenerationRoutesToOnlyCompatibleHelper(t *testing.T) {
	for _, same := range []bool{false, true} {
		t.Run(map[bool]string{false: "model-only-on-helper", true: "same-model-prefers-main"}[same], func(t *testing.T) {
			s, _, _ := openTest(t)
			site, err := s.CreateSite(testContext, "generation", 1, []string{"media.generate"})
			if err != nil {
				t.Fatal(err)
			}
			main, mainSession := testDevice(t, s)
			helper, helperSession := testDevice(t, s)
			setTestPriority(t, s, main, 100)
			selected := generationTestModel("selected")
			primary := generationTestModel("other")
			if same {
				primary = selected
			}
			if err = s.Heartbeat(testContext, main, mainSession, generationTestCaps(primary), testUsage()); err != nil {
				t.Fatal(err)
			}
			if err = s.Heartbeat(testContext, helper, helperSession, generationTestCaps(selected), testUsage()); err != nil {
				t.Fatal(err)
			}
			job := generationTestJob(selected)
			view, created, err := s.Submit(testContext, site.ID, encode(job))
			if err != nil || !created {
				t.Fatal(view, created, err)
			}
			offer, err := s.Offer(testContext, helper, helperSession)
			if err != nil {
				t.Fatal(err)
			}
			if same {
				if offer != nil {
					t.Fatal("helper bypassed compatible main")
				}
				offer, err = s.Offer(testContext, main, mainSession)
			}
			if err != nil || offer == nil || offer.JobID != job.ID {
				t.Fatal("compatible model was not routed", err)
			}
		})
	}
}
func TestGenerationRejectsUnknownInputsAndUnavailableModels(t *testing.T) {
	s, _, _ := openTest(t)
	site, err := s.CreateSite(testContext, "generation", 1, []string{"media.generate"})
	if err != nil {
		t.Fatal(err)
	}
	device, session := testDevice(t, s)
	m := generationTestModel("selected")
	if err = s.Heartbeat(testContext, device, session, generationTestCaps(m), testUsage()); err != nil {
		t.Fatal(err)
	}
	job := generationTestJob(m)
	var params map[string]any
	_ = json.Unmarshal(job.Params, &params)
	params["inputs"].(map[string]any)["unrecognized"] = true
	job.Params = encode(params)
	if _, _, err = s.Submit(testContext, site.ID, encode(job)); err == nil {
		t.Fatal("unknown input was accepted")
	}
	job = generationTestJob(m)
	usage := testUsage()
	usage.Paused = true
	_ = s.Heartbeat(testContext, device, session, generationTestCaps(m), usage)
	if _, _, err = s.Submit(testContext, site.ID, encode(job)); err == nil {
		t.Fatal("unavailable model was accepted")
	}
}
