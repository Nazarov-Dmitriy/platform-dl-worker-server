package dispatcher

import (
	"encoding/json"
	"testing"
)

func vttCaps() []Capability {
	return []Capability{{
		Code: "media.subtitles", RecognitionLanguages: []string{},
		TranslationDirections: []Pair{{"ru", "en"}}, AutoDetect: false,
		Formats: []string{"vtt"}, Availability: "ONLINE", ProfilePolicies: []string{},
		InputKinds: []string{"vtt"},
	}}
}

func TestVttTranslateJobRoutesToTranslationOnlyDevice(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	d, e := s.CreateDevice(testContext, "translate-only", vttCaps())
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.IssueToken(testContext, "DEVICE", d.ID); e != nil {
		t.Fatal(e)
	}
	var job map[string]any
	if e = json.Unmarshal(readFixture(t, "valid/job-subtitles-vtt.json").Value, &job); e != nil {
		t.Fatal(e)
	}
	job["id"] = UUID()
	v, created, e := s.Submit(testContext, site.ID, encode(job))
	if e != nil || !created || v.Status != "QUEUED" {
		t.Fatalf("%+v created=%v e=%v", v, created, e)
	}
}

func TestVttTranslateJobRejectedByLegacyVideoCapability(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	caps := []Capability{{
		Code: "media.subtitles", RecognitionLanguages: []string{"ru", "en"},
		TranslationDirections: []Pair{{"ru", "en"}}, AutoDetect: true,
		Formats: []string{"vtt"}, Availability: "ONLINE", ProfilePolicies: []string{},
	}}
	d, e := s.CreateDevice(testContext, "video-subtitles", caps)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.IssueToken(testContext, "DEVICE", d.ID); e != nil {
		t.Fatal(e)
	}
	var job map[string]any
	if e = json.Unmarshal(readFixture(t, "valid/job-subtitles-vtt.json").Value, &job); e != nil {
		t.Fatal(e)
	}
	job["id"] = UUID()
	v, created, e := s.Submit(testContext, site.ID, encode(job))
	if e != nil || created || v.Status != "REJECTED" || v.Error == nil || v.Error.Code != "OPERATION_UNAVAILABLE" {
		t.Fatalf("%+v created=%v e=%v", v, created, e)
	}
}

func TestVideoSubtitlesRejectedByTranslationOnlyDevice(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	d, e := s.CreateDevice(testContext, "translate-only", vttCaps())
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
		"speech":          map[string]any{"sourceLanguage": "ru", "mode": "FAST"},
		"includeOriginal": false,
		"targetLanguages": []string{"en"},
		"formats":         []string{"vtt"},
	}
	v, created, e := s.Submit(testContext, site.ID, encode(job))
	if e != nil || created || v.Status != "REJECTED" || v.Error == nil || v.Error.Code != "OPERATION_UNAVAILABLE" {
		t.Fatalf("%+v created=%v e=%v", v, created, e)
	}
}

func TestVttTranslateRejectsSourceLanguageTargetAndVideoSource(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	d, e := s.CreateDevice(testContext, "translate-only", vttCaps())
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.IssueToken(testContext, "DEVICE", d.ID); e != nil {
		t.Fatal(e)
	}
	var job map[string]any
	if e = json.Unmarshal(readFixture(t, "valid/job-subtitles-vtt.json").Value, &job); e != nil {
		t.Fatal(e)
	}
	job["id"] = UUID()
	job["params"].(map[string]any)["targetLanguages"] = []string{"ru"}
	if _, _, e = s.Submit(testContext, site.ID, encode(job)); e == nil {
		t.Fatal("source language target was accepted")
	}
	job["id"] = UUID()
	job["params"].(map[string]any)["targetLanguages"] = []string{"en"}
	src := job["source"].(map[string]any)
	src["contentType"] = "video/mp4"
	if _, _, e = s.Submit(testContext, site.ID, encode(job)); e == nil {
		t.Fatal("video source was accepted for VTT job")
	}
}

func TestSiteCapabilitiesMergeSubtitleInputKinds(t *testing.T) {
	s, _, _ := openTest(t)
	site := testSite(t, s, 1)
	if _, e := s.CreateDevice(testContext, "translate-only", vttCaps()); e != nil {
		t.Fatal(e)
	}
	body, e := s.Capabilities(testContext, site.ID)
	if e != nil {
		t.Fatal(e)
	}
	ops := body["operations"].([]Capability)
	var sub Capability
	for _, op := range ops {
		if op.Code == "media.subtitles" {
			sub = op
		}
	}
	if !contains(sub.InputKinds, "vtt") || contains(sub.InputKinds, "video") {
		t.Fatalf("%+v", sub)
	}
}
