package dispatcher

import (
	"strings"
	"testing"
)

func TestSanitizeEventRedactsSecretsAndSignedURLs(t *testing.T) {
	ev := testDiagEvent()
	ev.Message = "Authorization: Bearer super-secret-token-value failed"
	ev.Cause = "wget https://storage.example.invalid/file?X-Amz-Signature=abc"
	ev.Context = `{"cartId":"c1","password":"hunter2","token":"abc","nested":{"x":1}}`
	ev.Stack = "Error: token=abc\n    at run (app.js:1:1)"
	got := sanitizeEvent(ev)
	if strings.Contains(got.Message, "super-secret") || strings.Contains(strings.ToLower(got.Message), "bearer super") {
		t.Fatalf("token leaked in message: %s", got.Message)
	}
	if strings.Contains(got.Cause, "http") || strings.Contains(got.Cause, "Signature") {
		t.Fatalf("url leaked in cause: %s", got.Cause)
	}
	if strings.Contains(got.Context, "hunter2") || strings.Contains(got.Context, "abc") {
		t.Fatalf("secret leaked in context: %s", got.Context)
	}
	if !strings.Contains(got.Context, "cartId") {
		t.Fatalf("allowlisted context dropped: %s", got.Context)
	}
	if strings.Contains(got.Context, "nested") {
		t.Fatalf("nested context kept: %s", got.Context)
	}
}

func TestSanitizeEventKeepsPlainText(t *testing.T) {
	ev := sanitizeEvent(testDiagEvent())
	if ev.Message != "Unhandled checkout failure" {
		t.Fatalf("message = %q", ev.Message)
	}
}
