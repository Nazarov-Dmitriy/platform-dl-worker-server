package dispatcher

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	secretPattern = regexp.MustCompile(`(?i)((?:authorization:\s*)?bearer\s+\S+|password\s*[=:]\s*\S+|(x-amz-signature|awsaccesskeyid|signature|token|api[_-]?key)\s*[=:]\s*[^\s&"']+|sk-[a-zA-Z0-9]{8,})`)
	signedURL     = regexp.MustCompile(`(?i)https?://\S+`)
	contextKey    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)
)

var blockedContextKeys = map[string]bool{
	"token": true, "password": true, "authorization": true, "cookie": true,
	"secret": true, "signature": true, "set-cookie": true, "api_key": true,
	"apikey": true, "accesskey": true, "privatekey": true,
}

func sanitizeEvent(ev DiagnosticsEvent) DiagnosticsEvent {
	ev.Service = clip(cleanText(ev.Service), 128)
	ev.Environment = clip(cleanText(ev.Environment), 64)
	ev.Release = clip(cleanText(ev.Release), 64)
	ev.Code = clip(cleanText(ev.Code), 128)
	ev.Module = clip(cleanText(ev.Module), 128)
	ev.Operation = clip(cleanText(ev.Operation), 128)
	ev.Stage = clip(cleanText(ev.Stage), 64)
	ev.Message = nonEmpty(clip(redactText(ev.Message), maxMessageBytes), "(redacted)")
	ev.Cause = clip(redactText(ev.Cause), maxCauseBytes)
	ev.Stack = clip(redactText(ev.Stack), maxStackBytes)
	ev.Context = clip(sanitizeContext(ev.Context), maxContextBytes)
	ev.RequestID = clip(cleanText(ev.RequestID), 128)
	ev.OperationID = clip(cleanText(ev.OperationID), 128)
	ev.ResourceID = clip(cleanText(ev.ResourceID), 128)
	ev.JobID = clip(cleanText(ev.JobID), 128)
	ev.DeviceID = clip(cleanText(ev.DeviceID), 128)
	if len(ev.Breadcrumbs) > maxBreadcrumbs {
		ev.Breadcrumbs = ev.Breadcrumbs[:maxBreadcrumbs]
	}
	for i := range ev.Breadcrumbs {
		ev.Breadcrumbs[i].Category = clip(cleanText(ev.Breadcrumbs[i].Category), 64)
		ev.Breadcrumbs[i].Message = nonEmpty(clip(redactText(ev.Breadcrumbs[i].Message), maxMessageBytes), "(redacted)")
		ev.Breadcrumbs[i].Data = clip(redactText(ev.Breadcrumbs[i].Data), maxCauseBytes)
	}
	return ev
}

func redactText(s string) string {
	s = cleanText(s)
	s = secretPattern.ReplaceAllString(s, "[redacted]")
	s = signedURL.ReplaceAllString(s, "[url]")
	return s
}

func cleanText(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' || (r >= 32 && r != 127 && !unicode.Is(unicode.C, r)) {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

func sanitizeContext(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return redactText(raw)
	}
	filtered := filterContext(v, 0)
	out, e := json.Marshal(filtered)
	if e != nil {
		return redactText(raw)
	}
	return string(out)
}

func filterContext(v any, depth int) any {
	if depth > 1 {
		return nil
	}
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range t {
			if !contextKey.MatchString(k) || blockedContext(k) {
				continue
			}
			switch val.(type) {
			case string:
				out[k] = clip(redactText(val.(string)), 512)
			case float64, bool, nil:
				out[k] = val
			default:
				// Nested objects and arrays are dropped to keep cardinality bounded.
			}
		}
		return out
	case string:
		return clip(redactText(t), 512)
	case float64, bool, nil:
		return t
	default:
		return nil
	}
}

func blockedContext(key string) bool {
	k := strings.ToLower(strings.ReplaceAll(key, "-", ""))
	k = strings.ReplaceAll(k, "_", "")
	if blockedContextKeys[strings.ToLower(key)] || blockedContextKeys[k] {
		return true
	}
	for _, part := range []string{"token", "secret", "password", "signature", "authorization"} {
		if strings.Contains(strings.ToLower(key), part) {
			return true
		}
	}
	return false
}

func clip(s string, n int) string {
	if n <= 0 || len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}

func nonEmpty(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}
