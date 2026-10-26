package panel

import "embed"

//go:embed index.html *.js app.css login
var Files embed.FS
