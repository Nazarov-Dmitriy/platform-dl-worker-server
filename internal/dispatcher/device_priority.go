package dispatcher

import (
	"database/sql"
	"encoding/json"
	"time"
)

type preferredDevice struct {
	caps  []Capability
	usage Usage
}

// Only a ready, compatible device with capacity may reserve work ahead of a helper.
// Offered assignments count as occupied slots, so concurrent polls cannot overbook it.
func (s *Store) preferredDevices(tx *sql.Tx, priority int, now time.Time) ([]preferredDevice, error) {
	rows, e := tx.Query(`SELECT d.last_seen,d.ready_since,d.capabilities,d.usage,
 (SELECT count(*) FROM assignments a WHERE a.device_id=d.id AND a.state!='CLOSED')
 FROM devices d WHERE d.priority>? AND d.enabled=1 AND d.deleted=0 AND d.session_id!=''
 AND EXISTS(SELECT 1 FROM tokens t WHERE t.id=d.session_token AND t.principal_id=d.id AND t.purpose='DEVICE' AND t.revoked=0)`, priority)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	result := []preferredDevice{}
	for rows.Next() {
		var seen, ready int64
		var booked int
		var capsRaw, usageRaw string
		var d preferredDevice
		if e = rows.Scan(&seen, &ready, &capsRaw, &usageRaw, &booked); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(capsRaw), &d.caps); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(usageRaw), &d.usage); e != nil {
			return nil, e
		}
		if now.UnixMilli()-seen > s.config.OnlineTTL.Milliseconds() || ready == 0 || now.Sub(time.UnixMilli(ready)) < s.config.AdmissionStable || !s.admissible(d.usage) || booked >= d.usage.AvailableSlots {
			continue
		}
		result = append(result, d)
	}
	return result, rows.Err()
}

func preferredCanRun(devices []preferredDevice, job JobRequest) bool {
	for _, d := range devices {
		if compatible(job, d.caps, true) && d.usage.FreeDiskBytes >= job.Source.Bytes && d.usage.FreeDiskBytes-job.Source.Bytes >= job.MaxOutputBytes {
			return true
		}
	}
	return false
}
