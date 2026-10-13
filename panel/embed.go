package panel

import "embed"

//go:embed index.html app.js app.css
var Files embed.FS
