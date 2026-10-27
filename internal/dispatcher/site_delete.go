package dispatcher

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
)

// Preserve historical job references while revoking all access to a removed site.
func (s *Store) AdminDeleteSite(ctx context.Context, actor AdminActor, id, match string) error {
	if err := requireSites(actor); err != nil {
		return err
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		var revision int64
		err := tx.QueryRow("SELECT revision FROM sites WHERE id=? AND deleted=0", id).Scan(&revision)
		if errors.Is(err, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Site not found")
		}
		if err != nil {
			return err
		}
		if err = matchRevision(match, revision); err != nil {
			return err
		}
		var active int
		if err = tx.QueryRow("SELECT count(*) FROM jobs WHERE site_id=? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','REJECTED','CANCELLED','RELEASED')", id).Scan(&active); err != nil {
			return err
		}
		if active > 0 {
			return problem(409, "SITE_BUSY", "Finish or cancel site jobs before deletion")
		}
		if _, err = tx.Exec("UPDATE sites SET deleted=1,enabled=0,revision=revision+1 WHERE id=?", id); err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE tokens SET revoked=1 WHERE purpose='SITE' AND principal_id=?", id); err != nil {
			return err
		}
		if _, err = tx.Exec("DELETE FROM scheduler_credits WHERE site_id=?", id); err != nil {
			return err
		}
		return audit(tx, s.now().UnixMilli(), "SITE_DELETED", actor.ID, id)
	})
}
func (h *HTTP) adminDeleteSite(w http.ResponseWriter, r *http.Request, a AdminActor) {
	if err := h.store.AdminDeleteSite(r.Context(), a, r.PathValue("id"), r.Header.Get("If-Match")); err != nil {
		h.failure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
