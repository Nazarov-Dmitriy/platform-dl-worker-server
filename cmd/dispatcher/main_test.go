package main

import (
	"path/filepath"
	"strings"
	"testing"

	"context"
	"titunki/worker-server/internal/dispatcher"
)

func TestOwnerPasswordInput(t *testing.T) {
	for _, ending := range []string{"", "\n", "\r\n"} {
		got, err := readOwnerPassword(strings.NewReader("  long-password  " + ending))
		if err != nil || got != "  long-password  " {
			t.Fatalf("password whitespace changed: %v", err)
		}
	}
	for _, value := range []string{"short", "long-password\nextra", "long-password\x00", strings.Repeat("x", 4097)} {
		if _, err := readOwnerPassword(strings.NewReader(value)); err == nil {
			t.Fatal("accepted invalid password input")
		}
	}
}

func TestBootstrapIfNeededPreservesExistingOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dispatcher.db")
	if err := run([]string{"owner-bootstrap", "-db", path, "-login", "original", "-password", "original-password"}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"owner-bootstrap", "-db", path, "-login", "replacement", "-password", "replacement-password", "-if-needed"}); err != nil {
		t.Fatal(err)
	}
	store, err := dispatcher.Open(path, dispatcher.DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.ResetOwnerPassword(context.Background(), "original", "another-password"); err != nil {
		t.Fatal("original owner was not preserved", err)
	}
	if err := store.ResetOwnerPassword(context.Background(), "replacement", "another-password"); err == nil {
		t.Fatal("replacement owner was created")
	}
}
