## Summary

- Introduce `vramThresholdPercent` (default 80%, max 80) across the full stack — JSON schema, Go dispatcher, TS processor, and admin panel
- The slot budget now checks VRAM usage and blocks new work when the threshold is reached, recovering automatically below it
- Update device table to show VRAM in GB and add a CPU icon to the panel toolbar
- Add unit test for VRAM threshold behavior

## Changed files

- `contracts/` — schema + build script
- `internal/dispatcher/` — Go types + test
- `processor/src/` — config, agent, resources, tests
- `panel/` — app.js, common.js, index.html, render.js
- `docs/maket/worker.html` — new file
