package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"titunki/worker-server/internal/dispatcher"
)

func TestContainerUsesChosenPasswordAndDoesNotResetAccount(t *testing.T) {
	dir := t.TempDir()
	store, e := dispatcher.Open(filepath.Join(dir, "dispatcher.db"), dispatcher.DefaultConfig())
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	t.Setenv("DISPATCHER_OWNER", "chosen-owner")
	path := filepath.Join(dir, ".bootstrap-password")
	if e = os.WriteFile(path, []byte("chosen-password-123\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = bootstrapContainerOwner(store, dir); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("bootstrap password file was not consumed")
	}
	if _, e = store.Login(context.Background(), "127.0.0.1", []byte(`{"login":"chosen-owner","password":"chosen-password-123"}`)); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(path, []byte("replacement-password\n"), 0600)
	if e = bootstrapContainerOwner(store, dir); e != nil {
		t.Fatal(e)
	}
	if _, e = store.Login(context.Background(), "127.0.0.1", []byte(`{"login":"chosen-owner","password":"chosen-password-123"}`)); e != nil {
		t.Fatal("account password was reset", e)
	}
}
