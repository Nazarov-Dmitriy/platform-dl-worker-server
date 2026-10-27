package dispatcher

import (
	"errors"
	"strings"

	"github.com/google/uuid"
)

// This is an explicit per-site exception for development storage, not a global TLS bypass.
func (c *Config) SetPrivateHTTPStorageSites(value string) error {
	c.PrivateHTTPStorageSites = map[string]bool{}
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	if len(parts) > 100 {
		return errors.New("too many private HTTP storage site IDs")
	}
	for _, raw := range parts {
		id, e := uuid.Parse(strings.TrimSpace(raw))
		if e != nil {
			return errors.New("invalid private HTTP storage site ID")
		}
		c.PrivateHTTPStorageSites[id.String()] = true
	}
	return nil
}
