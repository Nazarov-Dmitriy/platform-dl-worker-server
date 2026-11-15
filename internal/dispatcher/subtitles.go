package dispatcher

import "encoding/json"

const maxSubtitleSourceBytes int64 = 2097152

type subtitleParams struct {
	Input           string   `json:"input"`
	SourceLanguage  string   `json:"sourceLanguage"`
	IncludeOriginal bool     `json:"includeOriginal"`
	TargetLanguages []string `json:"targetLanguages"`
	Formats         []string `json:"formats"`
	Speech          struct {
		SourceLanguage string `json:"sourceLanguage"`
	} `json:"speech"`
	Subtitles *struct {
		IncludeOriginal bool     `json:"includeOriginal"`
		TargetLanguages []string `json:"targetLanguages"`
	} `json:"subtitles"`
}

func parseSubtitleParams(raw json.RawMessage) subtitleParams {
	var p subtitleParams
	_ = json.Unmarshal(raw, &p)
	return p
}

func capInputKinds(c Capability) []string {
	if len(c.InputKinds) == 0 {
		return []string{"video"}
	}
	return c.InputKinds
}

func validateVttTranslateRequest(r JobRequest, p subtitleParams) error {
	if r.Source.Kind != "FILE" || r.Source.ContentType != "text/vtt" || r.Source.Role != "PUBLISHED_MEDIA" {
		return problem(400, "INVALID_SOURCE", "VTT translation needs a published text/vtt FILE")
	}
	if r.Source.Bytes <= 0 || r.Source.Bytes > maxSubtitleSourceBytes {
		return problem(400, "INVALID_SOURCE", "VTT source size is outside allowed limits")
	}
	if p.SourceLanguage == "" || p.SourceLanguage == "auto" {
		return problem(400, "INVALID_REQUEST", "VTT translation requires an explicit source language")
	}
	if len(p.TargetLanguages) == 0 {
		return problem(400, "INVALID_REQUEST", "Select at least one subtitle language")
	}
	if contains(p.TargetLanguages, p.SourceLanguage) {
		return problem(400, "INVALID_REQUEST", "Cannot translate a subtitle track onto its source language")
	}
	return nil
}

func subtitleFormatsOK(formats, supported []string) bool {
	if len(formats) == 0 {
		return contains(supported, "vtt")
	}
	for _, format := range formats {
		if !contains(supported, format) {
			return false
		}
	}
	return true
}

func translationSupported(c Capability, source string, targets []string) bool {
	for _, target := range targets {
		if target == source {
			continue
		}
		ok := false
		for _, pair := range c.TranslationDirections {
			if pair.Source == source && pair.Target == target {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}
