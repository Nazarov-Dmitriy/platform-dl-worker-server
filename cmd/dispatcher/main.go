package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"titunki/worker-server/internal/dispatcher"
	"titunki/worker-server/internal/servercert"
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
	secureCookies := flags.Bool("secure-cookies", false, "Set Secure on admin cookies when served behind an HTTPS proxy")
	listen := flags.String("listen", "127.0.0.1:8090", "HTTP listen address behind HTTPS proxy")
	host := flags.String("host", os.Getenv("DISPATCHER_HOST"), "Public IP or DNS name for built-in TLS")
	name := flags.String("name", "", "Site/device name")
	id := flags.String("id", "", "Site/device/token UUID")
	purpose := flags.String("purpose", "", "Token purpose: SITE or DEVICE")
	weight := flags.Int("weight", 1, "Site weight 1..100")
	ops := flags.String("operations", "media.transcode", "Comma-separated operations")
	capsPath := flags.String("capabilities", "", "JSON file with verified offline device capabilities")
	catalog := flags.String("catalog", "", "JSON array of ModelEntry records")
	commandFile := flags.String("command", "", "JSON AdminCommand for a device")
	login := flags.String("login", "", "Owner login")
	password := flags.String("password", "", "Owner password (12+ characters)")
	passwordStdin := flags.Bool("password-stdin", false, "Read owner password from stdin, not process arguments")
	ifNeeded := flags.Bool("if-needed", false, "Leave an existing owner unchanged (owner-bootstrap only)")
	from := flags.String("from", "", "SQLite snapshot path for restore")
	out := flags.String("out", "", "Optional backup destination file")
	keep := flags.Int("keep", 7, "Local snapshot copies to retain")
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
	if *ifNeeded && command != "owner-bootstrap" {
		return errors.New("-if-needed is only supported for owner-bootstrap")
	}
	if *passwordStdin {
		if (command != "owner-bootstrap" && command != "owner-reset-password") || *password != "" {
			return errors.New("-password-stdin requires an owner command without -password")
		}
		value, e := readOwnerPassword(os.Stdin)
		if e != nil {
			return e
		}
		*password = value
	}
	config := dispatcher.DefaultConfig()
	config.HistoryDays = *history
	config.AuditDays = *audit
	config.HeartbeatInterval = *heartbeat
	config.LeaseTTL = *lease
	config.StopSafety = *safety
	config.AdmissionStable = *stable
	if command == "health" {
		return checkHealth(filepath.Dir(*dbPath), *listen, *host)
	}
	if command == "restore" {
		epoch, e := dispatcher.RestoreDatabase(*dbPath, *from, config)
		if e != nil {
			return e
		}
		return output(map[string]any{"status": "restored", "epoch": epoch, "maintenance": true})
	}
	store, e := dispatcher.Open(*dbPath, config)
	if e != nil {
		return e
	}
	defer store.Close()
	ctx := context.Background()
	var certificates *servercert.Manager
	if command == "launch" {
		certificates, e = servercert.New(filepath.Dir(*dbPath), *host)
		if e != nil {
			return e
		}
		if e = bootstrapContainerOwner(store, filepath.Dir(*dbPath)); e != nil {
			return e
		}
		*secureCookies = true
	}
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
	case "catalog-list":
		v, e := store.Models(ctx)
		if e != nil {
			return e
		}
		return output(v)
	case "catalog-import":
		if *catalog == "" {
			return errors.New("catalog-import requires -catalog")
		}
		raw, e := os.ReadFile(*catalog)
		if e != nil {
			return e
		}
		if e = store.ImportCatalog(ctx, raw); e != nil {
			return e
		}
		return output(map[string]string{"status": "imported"})
	case "command-enqueue":
		if *id == "" || *commandFile == "" {
			return errors.New("command-enqueue requires -id and -command")
		}
		raw, e := os.ReadFile(*commandFile)
		if e != nil {
			return e
		}
		v, e := store.EnqueueCommand(ctx, *id, raw)
		if e != nil {
			return e
		}
		return output(v)
	case "command-get":
		if *id == "" {
			return errors.New("command-get requires -id (requestId)")
		}
		v, e := store.Command(ctx, *id)
		if e != nil {
			return e
		}
		return output(v)
	case "owner-bootstrap":
		if e := store.BootstrapOwner(ctx, *login, *password); e != nil {
			var api *dispatcher.APIError
			if *ifNeeded && errors.As(e, &api) && api.Code == "ALREADY_INITIALIZED" {
				return output(map[string]string{"status": "owner-exists"})
			}
			return e
		}
		return output(map[string]string{"status": "owner-created"})
	case "owner-reset-password":
		if e := store.ResetOwnerPassword(ctx, *login, *password); e != nil {
			return e
		}
		return output(map[string]string{"status": "password-reset"})
	case "backup":
		path, e := store.Snapshot(ctx, *keep)
		if e != nil {
			return e
		}
		if *out != "" && *out != path {
			raw, e := os.ReadFile(path)
			if e != nil {
				return e
			}
			if e = os.WriteFile(*out, raw, 0600); e != nil {
				return e
			}
			path = *out
		}
		return output(map[string]string{"status": "snapshot", "path": path})
	case "ops":
		v, e := store.OpsStatus(ctx)
		if e != nil {
			return e
		}
		return output(v)
	case "serve", "launch":
	default:
		return fmt.Errorf("unknown command %q", command)
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	handler := dispatcher.HandlerWithSecureCookies(store, *secureCookies)
	if certificates != nil {
		handler.(*dispatcher.HTTP).ConfigureConnection(certificates)
	}
	defer handler.(*dispatcher.HTTP).CloseDevices()
	server := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	if certificates != nil {
		server.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: certificates.Certificate}
	}
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
	store.StartBackupLoop(ctx)
	done := make(chan error, 1)
	go func() {
		if certificates != nil {
			done <- server.ListenAndServeTLS("", "")
		} else {
			done <- server.ListenAndServe()
		}
	}()
	log.Printf("dispatcher listening on %s (stage 7, panel /panel/, health /healthz /readyz)", *listen)
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
			if certificates != nil {
				if e := certificates.Refresh(); e != nil {
					log.Print("certificate renewal failed; inspect connection configuration")
				}
			}
			if e := store.Prune(ctx); e != nil {
				log.Print("history cleanup failed; durable history retained")
			}
		}
	}
}

func readOwnerPassword(input io.Reader) (string, error) {
	value, err := io.ReadAll(io.LimitReader(input, 4097))
	if err != nil {
		return "", errors.New("cannot read owner password")
	}
	if len(value) > 4096 {
		return "", errors.New("owner password exceeds 4096 bytes")
	}
	password := strings.TrimSuffix(strings.TrimSuffix(string(value), "\n"), "\r")
	if strings.ContainsAny(password, "\r\n\x00") || len(password) < 12 {
		return "", errors.New("owner password must be a single line of at least 12 characters")
	}
	return password, nil
}
