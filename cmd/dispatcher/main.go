package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"titunki/worker-server/internal/dispatcher"
)

func main() {
	if e := run(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func output(v any) error { return json.NewEncoder(os.Stdout).Encode(v) }
func run(args []string) error {
	command := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}
	flags := flag.NewFlagSet("dispatcher "+command, flag.ContinueOnError)
	dbPath := flags.String("db", "data/dispatcher.db", "SQLite path (persistent directory)")
	listen := flags.String("listen", "127.0.0.1:8090", "HTTP listen address behind HTTPS proxy")
	name := flags.String("name", "", "Site/device name")
	id := flags.String("id", "", "Site/device/token UUID")
	purpose := flags.String("purpose", "", "Token purpose: SITE or DEVICE")
	weight := flags.Int("weight", 1, "Site weight 1..100")
	ops := flags.String("operations", "media.transcode", "Comma-separated operations")
	capsPath := flags.String("capabilities", "", "JSON file with verified offline device capabilities")
	enabled := flags.Bool("enabled", true, "Enable site/device")
	history := flags.Int("history-days", 30, "Terminal job history retention")
	audit := flags.Int("audit-days", 30, "Audit retention")
	heartbeat := flags.Duration("heartbeat", 15*time.Second, "Device heartbeat interval")
	lease := flags.Duration("lease", 120*time.Second, "Execution lease duration")
	safety := flags.Duration("stop-safety", 5*time.Second, "Local stop safety margin")
	stable := flags.Duration("admission-stable", 15*time.Second, "Admission stability period")
	if e := flags.Parse(args); e != nil {
		return e
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	config := dispatcher.DefaultConfig()
	config.HistoryDays = *history
	config.AuditDays = *audit
	config.HeartbeatInterval = *heartbeat
	config.LeaseTTL = *lease
	config.StopSafety = *safety
	config.AdmissionStable = *stable
	store, e := dispatcher.Open(*dbPath, config)
	if e != nil {
		return e
	}
	defer store.Close()
	ctx := context.Background()
	switch command {
	case "init":
		return output(map[string]string{"status": "initialized", "epoch": store.Epoch()})
	case "site-create":
		v, e := store.CreateSite(ctx, *name, *weight, strings.Split(*ops, ","))
		if e != nil {
			return e
		}
		return output(v)
	case "site-set":
		var changeOps [][]string
		flags.Visit(func(f *flag.Flag) {
			if f.Name == "operations" {
				values := []string{}
				if *ops != "" {
					values = strings.Split(*ops, ",")
				}
				changeOps = append(changeOps, values)
			}
		})
		if e := store.SetSite(ctx, *id, *enabled, *weight, changeOps...); e != nil {
			return e
		}
		return output(map[string]string{"status": "updated"})
	case "site-list":
		v, e := store.Sites(ctx)
		if e != nil {
			return e
		}
		return output(v)
	case "device-create":
		caps := []dispatcher.Capability{}
		if *capsPath != "" {
			raw, e := os.ReadFile(*capsPath)
			if e != nil {
				return e
			}
			if e = json.Unmarshal(raw, &caps); e != nil {
				return e
			}
		}
		v, e := store.CreateDevice(ctx, *name, caps)
		if e != nil {
			return e
		}
		return output(v)
	case "device-set":
		if e := store.SetDevice(ctx, *id, *enabled); e != nil {
			return e
		}
		return output(map[string]string{"status": "updated"})
	case "device-list":
		v, e := store.Devices(ctx)
		if e != nil {
			return e
		}
		return output(v)
	case "token-issue":
		v, secret, e := store.IssueToken(ctx, *purpose, *id)
		if e != nil {
			return e
		}
		return output(map[string]any{"tokenId": v.TokenID, "purpose": v.Purpose, "token": secret})
	case "token-list":
		v, e := store.Tokens(ctx)
		if e != nil {
			return e
		}
		return output(v)
	case "token-revoke":
		if e := store.RevokeToken(ctx, *id); e != nil {
			return e
		}
		return output(map[string]string{"status": "revoked"})
	case "prune":
		if e := store.Prune(ctx); e != nil {
			return e
		}
		return output(map[string]string{"status": "pruned"})
	case "serve":
	default:
		return fmt.Errorf("unknown command %q", command)
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	handler := dispatcher.Handler(store)
	defer handler.(*dispatcher.HTTP).CloseDevices()
	server := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	prune := time.NewTicker(time.Hour)
	defer prune.Stop()
	if e = store.Expire(ctx); e != nil {
		return e
	}
	if e = store.Prune(ctx); e != nil {
		return e
	}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	log.Printf("dispatcher listening on %s (stage 4, transfers and publication)", *listen)
	for {
		select {
		case e := <-done:
			if errors.Is(e, http.ErrServerClosed) {
				return nil
			}
			return e
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			handler.(*dispatcher.HTTP).CloseDevices()
			return server.Shutdown(shutdown)
		case <-ticker.C:
			if e := store.Expire(ctx); e != nil {
				log.Print("lease expiry failed; durable queue retained")
			}
		case <-prune.C:
			if e := store.Prune(ctx); e != nil {
				log.Print("history cleanup failed; durable history retained")
			}
		}
	}
}
