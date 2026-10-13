// Package contracts exposes the versioned wire schemas to the dispatcher binary.
package contracts

import "embed"

//go:embed v2/protocol.schema.json
var Files embed.FS
