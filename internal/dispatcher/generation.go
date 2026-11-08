package dispatcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"
)

type GenerationParameter struct {
	Key       string            `json:"key"`
	Label     string            `json:"label"`
	Type      string            `json:"type"`
	Required  bool              `json:"required"`
	Default   json.RawMessage   `json:"default,omitempty"`
	Minimum   *float64          `json:"minimum,omitempty"`
	Maximum   *float64          `json:"maximum,omitempty"`
	Step      *float64          `json:"step,omitempty"`
	MaxLength int               `json:"maxLength,omitempty"`
	Options   []json.RawMessage `json:"options,omitempty"`
}
type GenerationModel struct {
	ID               string                `json:"id"`
	Revision         string                `json:"revision"`
	ProfileRevision  string                `json:"profileRevision"`
	Name             string                `json:"name"`
	Description      string                `json:"description"`
	ParameterCount   int64                 `json:"parameterCount,omitempty"`
	AcceptsReference bool                  `json:"acceptsReference"`
	Parameters       []GenerationParameter `json:"parameters"`
}
type generationParams struct {
	ModelID         string         `json:"modelId"`
	ModelRevision   string         `json:"modelRevision"`
	ProfileRevision string         `json:"profileRevision"`
	Inputs          map[string]any `json:"inputs"`
}

func validateGenerationInputs(model GenerationModel, inputs map[string]any) bool {
	known := map[string]bool{}
	for _, field := range model.Parameters {
		if known[field.Key] {
			return false
		}
		known[field.Key] = true
		value, ok := inputs[field.Key]
		if !ok {
			if field.Required {
				return false
			}
			continue
		}
		switch field.Type {
		case "string":
			text, ok := value.(string)
			if !ok || strings.ContainsRune(text, 0) || field.MaxLength > 0 && utf8.RuneCountInString(text) > field.MaxLength || field.Required && strings.TrimSpace(text) == "" {
				return false
			}
		case "integer", "number":
			number, ok := value.(float64)
			if !ok || math.IsNaN(number) || math.IsInf(number, 0) || field.Type == "integer" && math.Trunc(number) != number {
				return false
			}
			if field.Minimum != nil && number < *field.Minimum || field.Maximum != nil && number > *field.Maximum {
				return false
			}
			if field.Step != nil {
				base := 0.0
				if field.Minimum != nil {
					base = *field.Minimum
				}
				remainder := (number - base) / *field.Step
				if math.Abs(remainder-math.Round(remainder)) > 1e-8 {
					return false
				}
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				return false
			}
		default:
			return false
		}
		if len(field.Options) > 0 {
			found := false
			for _, raw := range field.Options {
				var option any
				if json.Unmarshal(raw, &option) == nil && option == value {
					found = true
				}
			}
			if !found {
				return false
			}
		}
	}
	for key := range inputs {
		if !known[key] {
			return false
		}
	}
	return true
}
func generationCompatible(r JobRequest, c Capability) bool {
	var params generationParams
	if json.Unmarshal(r.Params, &params) != nil {
		return false
	}
	for _, model := range c.GenerationModels {
		if model.ID == params.ModelID && model.Revision == params.ModelRevision && model.ProfileRevision == params.ProfileRevision &&
			(r.Source.Kind == "" || model.AcceptsReference) && validateGenerationInputs(model, params.Inputs) {
			return true
		}
	}
	return false
}
func generationModelKey(m GenerationModel) string {
	return m.ID + "@" + m.Revision + "@" + m.ProfileRevision
}
func generationProfilesValid(models []GenerationModel) bool {
	seen := map[string]bool{}
	for _, model := range models {
		key := generationModelKey(model)
		if seen[key] {
			return false
		}
		seen[key] = true
		fields := map[string]bool{}
		for _, field := range model.Parameters {
			if fields[field.Key] || field.Minimum != nil && field.Maximum != nil && *field.Minimum > *field.Maximum {
				return false
			}
			fields[field.Key] = true
			values := append([]json.RawMessage{}, field.Options...)
			if field.Default != nil {
				values = append(values, field.Default)
			}
			for _, raw := range values {
				var value any
				if json.Unmarshal(raw, &value) != nil || !validateGenerationInputs(GenerationModel{Parameters: []GenerationParameter{field}}, map[string]any{field.Key: value}) {
					return false
				}
			}
		}
	}
	return true
}

// Installed models stay listed while the device is online, including when it is busy.
// Slot, CPU and memory admission is enforced later, when a queued job is offered.
func (s *Store) readyGenerationModels(tx *sql.Tx) ([]GenerationModel, error) {
	rows, err := tx.Query(`SELECT d.capabilities,d.usage,d.last_seen
 FROM devices d WHERE d.enabled=1 AND d.deleted=0 AND d.session_id!=''
 AND EXISTS(SELECT 1 FROM tokens t WHERE t.id=d.session_token AND t.principal_id=d.id AND t.purpose='DEVICE' AND t.revoked=0)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GenerationModel{}
	seen := map[string]string{}
	conflicts := map[string]bool{}
	now := s.now()
	for rows.Next() {
		var capsRaw, usageRaw string
		var last int64
		if err = rows.Scan(&capsRaw, &usageRaw, &last); err != nil {
			return nil, err
		}
		var caps []Capability
		var usage Usage
		if json.Unmarshal([]byte(capsRaw), &caps) != nil || json.Unmarshal([]byte(usageRaw), &usage) != nil {
			continue
		}
		if last == 0 || now.UnixMilli()-last > s.config.OnlineTTL.Milliseconds() || usage.Paused || !usage.WorkDiskAvailable {
			continue
		}
		for _, cap := range caps {
			if cap.Code != "media.generate" || cap.Availability != "ONLINE" {
				continue
			}
			for _, model := range cap.GenerationModels {
				key := generationModelKey(model)
				fingerprint := string(encode(model))
				if previous, ok := seen[key]; ok {
					if previous != fingerprint {
						conflicts[key] = true
					}
					continue
				}
				seen[key] = fingerprint
				out = append(out, model)
			}
		}
	}
	filtered := out[:0]
	for _, m := range out {
		if !conflicts[generationModelKey(m)] {
			filtered = append(filtered, m)
		}
	}
	sort.Slice(filtered, func(i, j int) bool { return generationModelKey(filtered[i]) < generationModelKey(filtered[j]) })
	return filtered, rows.Err()
}
func (s *Store) GenerationModels(ctx context.Context, site string) (map[string]any, error) {
	result := map[string]any{}
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		var enabled bool
		var raw string
		if err := tx.QueryRow("SELECT enabled,operations FROM sites WHERE id=? AND deleted=0", site).Scan(&enabled, &raw); err != nil {
			return problem(403, "FORBIDDEN", "Unknown site")
		}
		var allowed []string
		_ = json.Unmarshal([]byte(raw), &allowed)
		if !enabled || !contains(allowed, "media.generate") {
			return problem(403, "OPERATION_FORBIDDEN", "Image generation is not permitted for this site")
		}
		models, err := s.readyGenerationModels(tx)
		if err != nil {
			return err
		}
		result = map[string]any{"protocolVersion": "2.0", "models": models}
		return s.validator.Check("GenerationModelPage", encode(result))
	})
	return result, err
}
func (h *HTTP) generationModels(w http.ResponseWriter, r *http.Request, p Principal) {
	result, err := h.store.GenerationModels(r.Context(), p.ID)
	if err != nil {
		h.failure(w, err)
		return
	}
	h.reply(w, 200, result)
}

// Keep source absent for text generation while retaining the legacy media DTO.
func (r JobRequest) MarshalJSON() ([]byte, error) {
	type alias JobRequest
	raw, err := json.Marshal(alias(r))
	if err != nil {
		return nil, err
	}
	if r.Type != "media.generate" || r.Source.Kind != "" {
		return raw, nil
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	delete(fields, "source")
	return json.Marshal(fields)
}
