package dispatcher

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	maxFallbackLines = 64
	maxFallbackBytes = 256 << 10
)

// Reporter writes Worker diagnostics to the local journal. Sink failures stay
// in a bounded fallback file with counters and never call Record again.
type Reporter struct {
	store        *ErrorStore
	fallbackPath string
	mu           sync.Mutex
	reporting    bool
	component    string
}

func NewReporter(store *ErrorStore, fallbackPath, component string) *Reporter {
	if component == "" {
		component = "dispatcher"
	}
	return &Reporter{store: store, fallbackPath: fallbackPath, component: component}
}

func (r *Reporter) Report(ctx context.Context, ev DiagnosticsEvent) {
	if r == nil || r.store == nil {
		return
	}
	r.mu.Lock()
	if r.reporting {
		r.mu.Unlock()
		return
	}
	r.reporting = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.reporting = false
		r.mu.Unlock()
	}()
	ev.Source = "worker"
	if ev.EventID == "" {
		ev.EventID = UUID()
	}
	if ev.OccurredAt == "" {
		ev.OccurredAt = stamp(r.store.Now())
	}
	if ev.Service == "" {
		ev.Service = r.component
	}
	if ev.Severity == "" {
		ev.Severity = "error"
	}
	if ev.Message == "" {
		ev.Message = ev.Code
	}
	if ev.Message == "" {
		ev.Message = "Worker failure"
	}
	sender := DiagnosticsSender{ID: r.component, Area: "worker"}
	_, _, e := r.store.Record(ctx, sender, []DiagnosticsEvent{ev})
	if e == nil {
		r.drain(ctx)
		return
	}
	var api *APIError
	if errors.As(e, &api) && api.Status < 500 && api.Code != "QUOTA_EXCEEDED" && api.Code != "STORAGE_FULL" {
		return
	}
	r.writeFallback(ev)
}

func (r *Reporter) writeFallback(ev DiagnosticsEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fallbackPath == "" {
		r.store.addLost("lost_fallback", 1)
		return
	}
	_ = os.MkdirAll(filepath.Dir(r.fallbackPath), 0700)
	lines := r.readFallbackLocked()
	raw, _ := json.Marshal(ev)
	if len(raw) > 8<<10 {
		raw = raw[:8<<10]
	}
	lines = append(lines, string(raw))
	dropped := 0
	for len(lines) > maxFallbackLines {
		lines = lines[1:]
		dropped++
	}
	var size int
	for _, line := range lines {
		size += len(line) + 1
	}
	for size > maxFallbackBytes && len(lines) > 1 {
		size -= len(lines[0]) + 1
		lines = lines[1:]
		dropped++
	}
	tmp := r.fallbackPath + ".new"
	if e := os.WriteFile(tmp, []byte(joinLines(lines)), 0600); e != nil {
		r.store.addLost("lost_fallback", 1+dropped)
		return
	}
	if e := os.Rename(tmp, r.fallbackPath); e != nil {
		r.store.addLost("lost_fallback", 1+dropped)
		return
	}
	if dropped > 0 {
		r.store.addLost("lost_fallback", dropped)
	}
}

func (r *Reporter) drain(ctx context.Context) {
	r.mu.Lock()
	lines := r.readFallbackLocked()
	_ = os.Remove(r.fallbackPath)
	r.mu.Unlock()
	kept := []string{}
	for _, line := range lines {
		var ev DiagnosticsEvent
		if json.Unmarshal([]byte(line), &ev) != nil {
			r.store.addLost("lost_fallback", 1)
			continue
		}
		_, _, e := r.store.Record(ctx, DiagnosticsSender{ID: r.component, Area: "worker"}, []DiagnosticsEvent{ev})
		if e != nil {
			kept = append(kept, line)
		}
	}
	if len(kept) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	_ = os.WriteFile(r.fallbackPath, []byte(joinLines(kept)), 0600)
}

func (r *Reporter) readFallbackLocked() []string {
	f, e := os.Open(r.fallbackPath)
	if e != nil {
		return nil
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 256<<10)
	for sc.Scan() {
		if t := sc.Text(); t != "" {
			lines = append(lines, t)
		}
	}
	return lines
}

func (r *Reporter) FallbackCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.readFallbackLocked())
}

func joinLines(lines []string) string {
	out := ""
	for i, line := range lines {
		if i > 0 {
			out += "\n"
		}
		out += line
	}
	if out != "" {
		out += "\n"
	}
	return out
}

func (r *Reporter) ReportCode(ctx context.Context, code, message, module, jobID string) {
	r.Report(ctx, DiagnosticsEvent{
		OccurredAt: stamp(time.Now()),
		Code:       code,
		Message:    message,
		Module:     module,
		JobID:      jobID,
		Severity:   "error",
	})
}
