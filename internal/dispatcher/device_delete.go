package dispatcher

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
)

// Keep device identity for historical assignments, but remove it from administration and revoke access.
func (s *Store) AdminDeleteDevice(ctx context.Context, actor AdminActor, id, match string) error {
	if err := requireOwner(actor); err != nil {
		return err
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		var revision int64
		err := tx.QueryRow("SELECT revision FROM devices WHERE id=? AND deleted=0", id).Scan(&revision)
		if errors.Is(err, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Device not found")
		}
		if err != nil {
			return err
		}
		if err = matchRevision(match, revision); err != nil {
			return err
		}
		var active int
		if err = tx.QueryRow("SELECT count(*) FROM assignments WHERE device_id=? AND state IN ('OFFERED','RUNNING','CANCELLING','RELEASING')", id).Scan(&active); err != nil {
			return err
		}
		if active > 0 {
			return problem(409, "DEVICE_BUSY", "Wait for active assignments to finish before deleting the device")
		}
		if _, err = tx.Exec("UPDATE devices SET deleted=1,enabled=0,revision=revision+1,session_id='',session_token='',ready_since=0 WHERE id=?", id); err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE tokens SET revoked=1 WHERE purpose='DEVICE' AND principal_id=?", id); err != nil {
			return err
		}
		return audit(tx, s.now().UnixMilli(), "DEVICE_DELETED", actor.ID, id)
	})
}

func (h *HTTP) adminDeleteDevice(w http.ResponseWriter, r *http.Request, actor AdminActor) {
	id := r.PathValue("id")
	if err := h.store.AdminDeleteDevice(r.Context(), actor, id, r.Header.Get("If-Match")); err != nil {
		h.failure(w, err)
		return
	}
	h.hub.Lock()
	connection := h.hub.connections[id]
	h.hub.Unlock()
	if connection != nil {
		_ = connection.CloseNow()
	}
	w.WriteHeader(http.StatusNoContent)
}
