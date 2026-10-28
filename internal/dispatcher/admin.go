package dispatcher

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

const sessionTTL = 12 * time.Hour
const loginWindow = 15 * time.Minute
const loginLimit = 5

func hashPassword(pw string) string {
	var salt [16]byte
	if _, e := rand.Read(salt[:]); e != nil {
		panic(e)
	}
	key := argon2.IDKey([]byte(pw), salt[:], 3, 64*1024, 1, 32)
	return "argon2id$" + base64.RawStdEncoding.EncodeToString(salt[:]) + "$" + base64.RawStdEncoding.EncodeToString(key)
}
func checkPassword(stored, pw string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 3 || parts[0] != "argon2id" {
		return false
	}
	salt, e1 := base64.RawStdEncoding.DecodeString(parts[1])
	want, e2 := base64.RawStdEncoding.DecodeString(parts[2])
	if e1 != nil || e2 != nil {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, 3, 64*1024, 1, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}
func secret32() string {
	var b [32]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func (s *Store) BootstrapOwner(ctx context.Context, login, password string) error {
	if strings.TrimSpace(login) == "" || len(password) < 12 {
		return problem(400, "INVALID_ACCOUNT", "Owner login and password (12+ characters) are required")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		var n int
		if e := tx.QueryRow("SELECT count(*) FROM accounts").Scan(&n); e != nil {
			return e
		}
		if n != 0 {
			return problem(409, "ALREADY_INITIALIZED", "Owner account already exists")
		}
		if _, e := tx.Exec("INSERT INTO accounts(id,login,password_hash,role,manage_sites,enabled,created_at) VALUES(?,?,?,'OWNER',1,1,?)", UUID(), login, hashPassword(password), s.now().UnixMilli()); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "OWNER_BOOTSTRAP", login, "")
	})
}
func (s *Store) ResetOwnerPassword(ctx context.Context, login, password string) error {
	if strings.TrimSpace(login) == "" || len(password) < 12 {
		return problem(400, "INVALID_ACCOUNT", "Owner login and password (12+ characters) are required")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.Exec("UPDATE accounts SET password_hash=?,revision=revision+1 WHERE login=? COLLATE NOCASE AND role='OWNER'", hashPassword(password), login)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return problem(404, "NOT_FOUND", "Owner account not found")
		}
		if _, e = tx.Exec("DELETE FROM admin_sessions WHERE account_id IN (SELECT id FROM accounts WHERE login=? COLLATE NOCASE)", login); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "OWNER_PASSWORD_RESET", login, "")
	})
}

type sessionRecord struct {
	Secret string
	View   map[string]any
}

func (s *Store) Login(ctx context.Context, ip string, raw []byte) (sessionRecord, error) {
	var rec sessionRecord
	if e := s.validator.Check("Login", raw); e != nil {
		return rec, e
	}
	var in struct {
		Login, Password string
	}
	if json.Unmarshal(raw, &in) != nil {
		return rec, problem(400, "INVALID_REQUEST", "Invalid login")
	}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		cut := s.now().Add(-loginWindow).UnixMilli()
		var fails int
		if e := tx.QueryRow("SELECT count(*) FROM login_attempts WHERE login=? COLLATE NOCASE AND ip=? AND success=0 AND at>=?", in.Login, ip, cut).Scan(&fails); e != nil {
			return e
		}
		if fails >= loginLimit {
			return problem(429, "RATE_LIMITED", "Too many failed logins")
		}
		var id, hash, role string
		var manage, enabled int
		e := tx.QueryRow("SELECT id,password_hash,role,manage_sites,enabled FROM accounts WHERE login=? COLLATE NOCASE", in.Login).Scan(&id, &hash, &role, &manage, &enabled)
		ok := e == nil && enabled == 1 && checkPassword(hash, in.Password)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		success := 0
		if ok {
			success = 1
		}
		if _, e2 := tx.Exec("INSERT INTO login_attempts(at,login,ip,success) VALUES(?,?,?,?)", s.now().UnixMilli(), in.Login, ip, success); e2 != nil {
			return e2
		}
		if !ok {
			rec.View = map[string]any{"unauthorized": true}
			return nil
		}
		secret := secret32()
		csrf := secret32()
		sid := UUID()
		until := s.now().Add(sessionTTL)
		if _, e = tx.Exec("INSERT INTO admin_sessions(id,account_id,hash,csrf,expires_at,created_at) VALUES(?,?,?,?,?,?)", sid, id, digest([]byte(secret)), csrf, until.UnixMilli(), s.now().UnixMilli()); e != nil {
			return e
		}
		rec.Secret = secret
		rec.View = map[string]any{"accountId": id, "role": role, "manageSites": manage == 1, "csrfToken": csrf}
		return audit(tx, s.now().UnixMilli(), "ADMIN_LOGIN", id, "")
	})
	if e != nil {
		return rec, e
	}
	if rec.Secret == "" {
		return rec, problem(401, "UNAUTHORIZED", "Invalid login or password")
	}
	return rec, nil
}
func (s *Store) LookupSession(ctx context.Context, secret string) (AdminActor, string, error) {
	var a AdminActor
	var csrf string
	if secret == "" {
		return a, "", problem(401, "UNAUTHORIZED", "Admin session required")
	}
	var manage, enabled int
	var expires int64
	e := s.db.QueryRowContext(ctx, `SELECT a.id,a.login,a.role,a.manage_sites,a.enabled,s.csrf,s.expires_at
 FROM admin_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=?`, digest([]byte(secret))).Scan(&a.ID, &a.Login, &a.Role, &manage, &enabled, &csrf, &expires)
	if errors.Is(e, sql.ErrNoRows) {
		return a, "", problem(401, "UNAUTHORIZED", "Admin session required")
	}
	if e != nil {
		return a, "", e
	}
	if enabled != 1 || expires <= s.now().UnixMilli() {
		return a, "", problem(401, "UNAUTHORIZED", "Admin session expired")
	}
	a.ManageSites = a.Role == "OWNER" || manage == 1
	return a, csrf, nil
}
func (s *Store) Logout(ctx context.Context, secret string) error {
	_, e := s.db.ExecContext(ctx, "DELETE FROM admin_sessions WHERE hash=?", digest([]byte(secret)))
	return e
}
func (s *Store) SessionView(a AdminActor, csrf string) map[string]any {
	return map[string]any{"accountId": a.ID, "role": a.Role, "manageSites": a.ManageSites, "csrfToken": csrf}
}

func requireOwner(a AdminActor) error {
	if a.Role != "OWNER" {
		return problem(403, "FORBIDDEN", "Owner role required")
	}
	return nil
}
func requireSites(a AdminActor) error {
	if a.Role != "OWNER" && !a.ManageSites {
		return problem(403, "FORBIDDEN", "Site management is not permitted")
	}
	return nil
}

func matchRevision(header string, current int64) error {
	if header == "" {
		return problem(428, "PRECONDITION_REQUIRED", "If-Match revision is required")
	}
	if len(header) < 3 || header[0] != '"' || header[len(header)-1] != '"' {
		return problem(428, "PRECONDITION_REQUIRED", "If-Match revision is required")
	}
	n, e := strconv.ParseInt(header[1:len(header)-1], 10, 64)
	if e != nil || n < 1 {
		return problem(428, "PRECONDITION_REQUIRED", "If-Match revision is required")
	}
	if n != current {
		return problem(409, "REVISION_CONFLICT", "Record was updated")
	}
	return nil
}

func (s *Store) AdminCreateSite(ctx context.Context, a AdminActor, raw []byte) (map[string]any, error) {
	if e := requireSites(a); e != nil {
		return nil, e
	}
	if e := s.validator.Check("AdminSite", raw); e != nil {
		return nil, e
	}
	var in struct {
		Name       string   `json:"name"`
		Enabled    bool     `json:"enabled"`
		Operations []string `json:"operations"`
		Weight     int      `json:"weight"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return nil, problem(400, "INVALID_REQUEST", "Invalid site")
	}
	site, e := s.CreateSite(ctx, in.Name, in.Weight, in.Operations)
	if e != nil {
		return nil, e
	}
	if !in.Enabled {
		if e = s.SetSite(ctx, site.ID, false, in.Weight, in.Operations); e != nil {
			return nil, e
		}
		site.Enabled = false
	}
	return map[string]any{"id": site.ID, "name": site.Name, "enabled": site.Enabled, "operations": site.Operations, "weight": site.Weight, "revision": site.Revision, "tokenSet": false}, nil
}
func (s *Store) AdminUpdateSite(ctx context.Context, a AdminActor, id, match string, raw []byte) (map[string]any, error) {
	if e := requireSites(a); e != nil {
		return nil, e
	}
	if e := s.validator.Check("AdminSite", raw); e != nil {
		return nil, e
	}
	var in struct {
		Name       string   `json:"name"`
		Enabled    bool     `json:"enabled"`
		Operations []string `json:"operations"`
		Weight     int      `json:"weight"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return nil, problem(400, "INVALID_REQUEST", "Invalid site")
	}
	var view map[string]any
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var name string
		var enabled, weight int
		var ops string
		var rev int64
		e := tx.QueryRow("SELECT name,enabled,weight,operations,revision FROM sites WHERE id=? AND deleted=0", id).Scan(&name, &enabled, &weight, &ops, &rev)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Site not found")
		}
		if e != nil {
			return e
		}
		if e = matchRevision(match, rev); e != nil {
			return e
		}
		if _, e = tx.Exec("UPDATE sites SET name=?,enabled=?,weight=?,operations=?,revision=revision+1 WHERE id=?", in.Name, boolInt(in.Enabled), in.Weight, string(encode(in.Operations)), id); e != nil {
			return e
		}
		if _, e = tx.Exec("DELETE FROM scheduler_credits"); e != nil {
			return e
		}
		rev++
		view = map[string]any{"id": id, "name": in.Name, "enabled": in.Enabled, "operations": in.Operations, "weight": in.Weight, "revision": rev, "tokenSet": tokenSet(tx, "SITE", id)}
		return audit(tx, s.now().UnixMilli(), "SITE_UPDATED", a.ID, id)
	})
	return view, e
}
func (s *Store) AdminListSites(ctx context.Context, a AdminActor) (map[string]any, error) {
	if a.Role != "OWNER" && !a.ManageSites {
		return map[string]any{"items": []any{}, "nextCursor": nil}, nil
	}
	sites, e := s.Sites(ctx)
	if e != nil {
		return nil, e
	}
	items := make([]map[string]any, 0, len(sites))
	e = s.transaction(ctx, func(tx *sql.Tx) error {
		for _, site := range sites {
			items = append(items, map[string]any{"id": site.ID, "name": site.Name, "enabled": site.Enabled, "operations": site.Operations, "weight": site.Weight, "revision": site.Revision, "tokenSet": tokenSet(tx, "SITE", site.ID)})
		}
		return nil
	})
	return map[string]any{"items": items, "nextCursor": nil}, e
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
func tokenSet(tx *sql.Tx, purpose, id string) bool {
	var n int
	_ = tx.QueryRow("SELECT count(*) FROM tokens WHERE purpose=? AND principal_id=? AND revoked=0", purpose, id).Scan(&n)
	return n > 0
}

func (s *Store) AdminCreateDevice(ctx context.Context, a AdminActor, raw []byte) (map[string]any, error) {
	if e := s.validator.Check("AdminDevice", raw); e != nil {
		return nil, e
	}
	var in struct {
		Name    string `json:"name"`
		Enabled bool   `json:"enabled"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return nil, problem(400, "INVALID_REQUEST", "Invalid device")
	}
	d, e := s.CreateDevice(ctx, in.Name, []Capability{})
	if e != nil {
		return nil, e
	}
	if !in.Enabled {
		if e = s.SetDevice(ctx, d.ID, false); e != nil {
			return nil, e
		}
		d.Enabled = false
	}
	return s.deviceView(ctx, d.ID)
}
func (s *Store) AdminUpdateDevice(ctx context.Context, a AdminActor, id, match string, raw []byte) (map[string]any, error) {
	if e := s.validator.Check("AdminDevice", raw); e != nil {
		return nil, e
	}
	var in struct {
		Name     string `json:"name"`
		Enabled  bool   `json:"enabled"`
		Priority *int   `json:"priority"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return nil, problem(400, "INVALID_REQUEST", "Invalid device")
	}
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var rev int64
		var name string
		var enabled, priority int
		e := tx.QueryRow("SELECT name,enabled,revision,priority FROM devices WHERE id=? AND deleted=0", id).Scan(&name, &enabled, &rev, &priority)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Device not found")
		}
		if e != nil {
			return e
		}
		if e = matchRevision(match, rev); e != nil {
			return e
		}
		if in.Priority != nil {
			priority = *in.Priority
		}
		if _, e = tx.Exec("UPDATE devices SET name=?,enabled=?,priority=?,revision=revision+1 WHERE id=?", in.Name, boolInt(in.Enabled), priority, id); e != nil {
			return e
		}
		if !in.Enabled {
			if _, e = tx.Exec("UPDATE devices SET session_id='',session_token='',ready_since=0 WHERE id=?", id); e != nil {
				return e
			}
		}
		return audit(tx, s.now().UnixMilli(), "DEVICE_UPDATED", a.ID, id)
	})
	if e != nil {
		return nil, e
	}
	return s.deviceView(ctx, id)
}
func (s *Store) AdminListDevices(ctx context.Context) (map[string]any, error) {
	devices, e := s.Devices(ctx)
	if e != nil {
		return nil, e
	}
	items := []map[string]any{}
	for _, d := range devices {
		v, e := s.deviceView(ctx, d.ID)
		if e != nil {
			return nil, e
		}
		items = append(items, v)
	}
	return map[string]any{"items": items, "nextCursor": nil}, nil
}
func (s *Store) deviceView(ctx context.Context, id string) (map[string]any, error) {
	var name string
	var enabled, last int64
	var rev int64
	var priority int
	var capsRaw, usageRaw, session string
	e := s.db.QueryRowContext(ctx, "SELECT name,enabled,revision,capabilities,usage,last_seen,session_id,priority FROM devices WHERE id=? AND deleted=0", id).Scan(&name, &enabled, &rev, &capsRaw, &usageRaw, &last, &session, &priority)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, problem(404, "NOT_FOUND", "Device not found")
	}
	if e != nil {
		return nil, e
	}
	var set bool
	var n int
	_ = s.db.QueryRowContext(ctx, "SELECT count(*) FROM tokens WHERE purpose='DEVICE' AND principal_id=? AND revoked=0", id).Scan(&n)
	set = n > 0
	online := session != "" && last > 0 && s.now().UnixMilli()-last <= s.config.OnlineTTL.Milliseconds()
	var lastSeen any
	if last > 0 {
		lastSeen = stamp(time.UnixMilli(last))
	}
	view := map[string]any{"id": id, "name": name, "enabled": enabled == 1, "revision": rev, "priority": priority, "tokenSet": set, "online": online, "lastSeenAt": lastSeen}
	var caps []Capability
	if json.Unmarshal([]byte(capsRaw), &caps) == nil && len(caps) > 0 {
		view["capabilities"] = caps
	}
	var usage Usage
	if json.Unmarshal([]byte(usageRaw), &usage) == nil && usage.MemoryPressure != "" {
		view["usage"] = usage
	}
	return view, s.validator.Check("AdminDeviceView", encode(view))
}

func (s *Store) AdminCreateAccount(ctx context.Context, a AdminActor, raw []byte) (map[string]any, error) {
	if e := requireOwner(a); e != nil {
		return nil, e
	}
	if e := s.validator.Check("AdminAccount", raw); e != nil {
		return nil, e
	}
	var in struct {
		Login, Password, Role string
		Enabled, ManageSites  bool
	}
	if json.Unmarshal(raw, &in) != nil {
		return nil, problem(400, "INVALID_REQUEST", "Invalid account")
	}
	id := UUID()
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		if _, e := tx.Exec("INSERT INTO accounts(id,login,password_hash,role,manage_sites,enabled,created_at) VALUES(?,?,?,?,?,?,?)", id, in.Login, hashPassword(in.Password), in.Role, boolInt(in.ManageSites), boolInt(in.Enabled), s.now().UnixMilli()); e != nil {
			if strings.Contains(strings.ToLower(e.Error()), "unique") {
				return problem(409, "LOGIN_IN_USE", "Login already exists")
			}
			return e
		}
		return audit(tx, s.now().UnixMilli(), "ACCOUNT_CREATED", a.ID, id)
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"id": id, "login": in.Login, "enabled": in.Enabled, "role": in.Role, "manageSites": in.ManageSites, "revision": 1}, nil
}
func (s *Store) AdminUpdateAccount(ctx context.Context, a AdminActor, id, match string, raw []byte) (map[string]any, error) {
	if e := requireOwner(a); e != nil {
		return nil, e
	}
	if e := s.validator.Check("AdminAccountUpdate", raw); e != nil {
		return nil, e
	}
	var in struct {
		Login, Password, Role string
		Enabled, ManageSites  bool
	}
	if json.Unmarshal(raw, &in) != nil {
		return nil, problem(400, "INVALID_REQUEST", "Invalid account")
	}
	if in.Password != "" && len(in.Password) < 12 {
		return nil, problem(400, "INVALID_ACCOUNT", "Password must be at least 12 characters")
	}
	var view map[string]any
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var login, role string
		var enabled, manage int
		var rev int64
		e := tx.QueryRow("SELECT login,role,manage_sites,enabled,revision FROM accounts WHERE id=?", id).Scan(&login, &role, &manage, &enabled, &rev)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Account not found")
		}
		if e != nil {
			return e
		}
		if e = matchRevision(match, rev); e != nil {
			return e
		}
		if role == "OWNER" && (in.Role != "OWNER" || !in.Enabled) {
			var owners int
			if e = tx.QueryRow("SELECT count(*) FROM accounts WHERE role='OWNER' AND enabled=1 AND id!=?", id).Scan(&owners); e != nil {
				return e
			}
			if owners == 0 {
				return problem(409, "LAST_OWNER", "Cannot disable or demote the last owner")
			}
		}
		if in.Password != "" {
			if _, e = tx.Exec("UPDATE accounts SET login=?,password_hash=?,role=?,manage_sites=?,enabled=?,revision=revision+1 WHERE id=?", in.Login, hashPassword(in.Password), in.Role, boolInt(in.ManageSites), boolInt(in.Enabled), id); e != nil {
				return e
			}
			if _, e = tx.Exec("DELETE FROM admin_sessions WHERE account_id=?", id); e != nil {
				return e
			}
		} else {
			if _, e = tx.Exec("UPDATE accounts SET login=?,role=?,manage_sites=?,enabled=?,revision=revision+1 WHERE id=?", in.Login, in.Role, boolInt(in.ManageSites), boolInt(in.Enabled), id); e != nil {
				return e
			}
		}
		view = map[string]any{"id": id, "login": in.Login, "enabled": in.Enabled, "role": in.Role, "manageSites": in.ManageSites, "revision": rev + 1}
		return audit(tx, s.now().UnixMilli(), "ACCOUNT_UPDATED", a.ID, id)
	})
	return view, e
}
func (s *Store) AdminListAccounts(ctx context.Context, a AdminActor) (map[string]any, error) {
	if e := requireOwner(a); e != nil {
		return nil, e
	}
	rows, e := s.db.QueryContext(ctx, "SELECT id,login,role,manage_sites,enabled,revision FROM accounts ORDER BY login")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, login, role string
		var manage, enabled int
		var rev int64
		if e = rows.Scan(&id, &login, &role, &manage, &enabled, &rev); e != nil {
			return nil, e
		}
		items = append(items, map[string]any{"id": id, "login": login, "role": role, "manageSites": manage == 1, "enabled": enabled == 1, "revision": rev})
	}
	return map[string]any{"items": items, "nextCursor": nil}, rows.Err()
}

func (s *Store) AdminIssueToken(ctx context.Context, a AdminActor, purpose, principal string, raw []byte) (map[string]any, error) {
	if e := s.validator.Check("TokenCreate", raw); e != nil {
		return nil, e
	}
	var in struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return nil, problem(400, "INVALID_REQUEST", "Invalid token request")
	}
	if purpose == "DEVICE" && a.Role != "OWNER" {
		return nil, problem(403, "FORBIDDEN", "Operators cannot issue device tokens")
	}
	if purpose == "SITE" {
		if e := requireSites(a); e != nil {
			return nil, e
		}
	}
	var issued map[string]any
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var existing string
		e := tx.QueryRow("SELECT token_id FROM token_requests WHERE request_id=?", in.RequestID).Scan(&existing)
		if e == nil {
			return problem(409, "TOKEN_SECRET_ALREADY_ISSUED", "Token secret was already shown; revoke and issue a new token")
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	view, secret, e := s.IssueToken(ctx, purpose, principal)
	if e != nil {
		return nil, e
	}
	if _, e = s.db.ExecContext(ctx, "INSERT INTO token_requests(request_id,purpose,principal_id,token_id) VALUES(?,?,?,?)", in.RequestID, purpose, principal, view.TokenID); e != nil {
		return nil, e
	}
	issued = map[string]any{"tokenId": view.TokenID, "token": secret, "purpose": purpose}
	return issued, s.validator.Check("IssuedToken", encode(issued))
}
func (s *Store) AdminListTokens(ctx context.Context, a AdminActor) (map[string]any, error) {
	all, e := s.Tokens(ctx)
	if e != nil {
		return nil, e
	}
	items := []TokenView{}
	for _, t := range all {
		if t.Purpose == "DEVICE" && a.Role != "OWNER" {
			continue
		}
		if t.Purpose == "SITE" && a.Role != "OWNER" && !a.ManageSites {
			continue
		}
		items = append(items, t)
	}
	return map[string]any{"items": items, "nextCursor": nil}, nil
}
func (s *Store) AdminRevokeToken(ctx context.Context, a AdminActor, id string, raw []byte) error {
	if e := s.validator.Check("Mutation", raw); e != nil {
		return e
	}
	var purpose string
	e := s.db.QueryRowContext(ctx, "SELECT purpose FROM tokens WHERE id=?", id).Scan(&purpose)
	if errors.Is(e, sql.ErrNoRows) {
		return problem(404, "NOT_FOUND", "Token not found")
	}
	if e != nil {
		return e
	}
	if purpose == "DEVICE" && a.Role != "OWNER" {
		return problem(403, "FORBIDDEN", "Operators cannot revoke device tokens")
	}
	if purpose == "SITE" {
		if e := requireSites(a); e != nil {
			return e
		}
	}
	return s.RevokeToken(ctx, id)
}

func (s *Store) AdminModels(ctx context.Context, device string) (map[string]any, error) {
	models, e := s.Models(ctx)
	if e != nil {
		return nil, e
	}
	if device != "" {
		var os, arch string
		_ = s.db.QueryRowContext(ctx, "SELECT os,architecture FROM device_identity WHERE device_id=?", device).Scan(&os, &arch)
		filtered := []ModelEntry{}
		for _, m := range models {
			if os != "" && !contains(m.OS, os) {
				continue
			}
			if arch != "" && !contains(m.Architectures, arch) {
				continue
			}
			filtered = append(filtered, m)
		}
		models = filtered
	}
	if len(models) > 100 {
		models = models[:100]
	}
	return map[string]any{"models": models, "nextCursor": nil}, nil
}

func (s *Store) AdminJobs(ctx context.Context, site string, after int64, limit int) (map[string]any, error) {
	if site == "" {
		return nil, problem(400, "INVALID_PAGE", "siteId is required")
	}
	jobs, cursor, e := s.List(ctx, site, after, limit)
	if e != nil {
		return nil, e
	}
	var next *string
	if len(jobs) == limit {
		v := strconv.FormatInt(cursor, 10)
		next = &v
	}
	return map[string]any{"protocolVersion": "2.0", "jobs": jobs, "nextCursor": next}, nil
}

func (s *Store) AdminCancelAll(ctx context.Context, a AdminActor, site string, raw []byte) (map[string]any, error) {
	if a.Role != "OWNER" && a.Role != "OPERATOR" {
		return nil, problem(403, "FORBIDDEN", "Queue control is not permitted")
	}
	if e := s.validator.Check("Mutation", raw); e != nil {
		return nil, e
	}
	var in struct {
		RequestID string `json:"requestId"`
	}
	_ = json.Unmarshal(raw, &in)
	cancelled := 0
	e := s.transaction(ctx, func(tx *sql.Tx) error {
		var old string
		e := tx.QueryRow("SELECT fingerprint FROM controls WHERE site_id=? AND job_id='*' AND id=?", site, in.RequestID).Scan(&old)
		if e == nil {
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		canonical, e := canonicalJSON(raw)
		if e != nil {
			return e
		}
		if _, e = tx.Exec("INSERT INTO controls(site_id,job_id,id,fingerprint,kind) VALUES(?,?,?,?,'cancel-all')", site, "*", in.RequestID, digest(canonical)); e != nil {
			return e
		}
		rows, e := tx.Query("SELECT id FROM jobs WHERE site_id=? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','REJECTED','CANCELLED','RELEASED','CANCELLING','RELEASING')", site)
		if e != nil {
			return e
		}
		defer rows.Close()
		ids := []string{}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				return e
			}
			ids = append(ids, id)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		cancelled = len(ids)
		return audit(tx, s.now().UnixMilli(), "SITE_CANCEL_ALL", a.ID, site)
	})
	if e != nil {
		return nil, e
	}
	jobs, _, e := s.List(ctx, site, 0, 100)
	if e != nil {
		return nil, e
	}
	for _, job := range jobs {
		if terminal(job.Status) || job.Status == "CANCELLING" || job.Status == "RELEASING" {
			continue
		}
		body := encode(map[string]any{"protocolVersion": "2.0", "requestId": UUID(), "reason": "admin cancel-all"})
		_, _ = s.Control(ctx, site, job.ID, "cancel", body)
	}
	return map[string]any{"protocolVersion": "2.0", "requestId": in.RequestID, "applied": true, "cancelled": cancelled}, nil
}

func (s *Store) DeviceSettings(ctx context.Context, id string) (map[string]any, error) {
	var os, arch, acc, desired, reported string
	e := s.db.QueryRowContext(ctx, "SELECT os,architecture,accelerators,desired_settings,reported_settings FROM device_identity WHERE device_id=?", id).Scan(&os, &arch, &acc, &desired, &reported)
	if errors.Is(e, sql.ErrNoRows) {
		var n int
		if e = s.db.QueryRowContext(ctx, "SELECT count(*) FROM devices WHERE id=?", id).Scan(&n); e != nil {
			return nil, e
		}
		if n == 0 {
			return nil, problem(404, "NOT_FOUND", "Device not found")
		}
		return map[string]any{"os": "", "architecture": "", "accelerators": []string{}, "desired": nil, "reported": nil}, nil
	}
	if e != nil {
		return nil, e
	}
	var accelerators []string
	_ = json.Unmarshal([]byte(acc), &accelerators)
	out := map[string]any{"os": os, "architecture": arch, "accelerators": accelerators, "desired": nil, "reported": nil}
	if desired != "" {
		var v any
		_ = json.Unmarshal([]byte(desired), &v)
		out["desired"] = v
	}
	if reported != "" {
		var v any
		_ = json.Unmarshal([]byte(reported), &v)
		out["reported"] = v
	}
	return out, nil
}

func (s *Store) AdminAudit(ctx context.Context, limit int) ([]map[string]any, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	rows, e := s.db.QueryContext(ctx, "SELECT at,kind,principal_id,job_id FROM audit ORDER BY seq DESC LIMIT ?", limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var at int64
		var kind, principal, job string
		if e = rows.Scan(&at, &kind, &principal, &job); e != nil {
			return nil, e
		}
		out = append(out, map[string]any{"at": stamp(time.UnixMilli(at)), "kind": kind, "principalId": principal, "jobId": job})
	}
	return out, rows.Err()
}
