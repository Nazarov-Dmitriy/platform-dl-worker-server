-- Unified error journal storage. Lives in its own errors.sqlite so that the
-- main job queue keeps a small, predictable write path and the diagnostics
-- volume can be pruned/backed up independently. See docs/plan/error-journal-plan.md.

CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);

-- One card per fingerprint. favorite/status protect the card from TTL.
CREATE TABLE error_groups (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  area TEXT NOT NULL CHECK(area IN ('sites','worker')),
  site_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  module TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','IN_PROGRESS','RESOLVED','IGNORED')),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  pinned_examples INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX error_groups_list ON error_groups(area, site_id, source, last_seen);
CREATE INDEX error_groups_status ON error_groups(status);

-- One row per diagnostic delivery. event_id is unique per trusted sender so a
-- replayed batch is acknowledged without creating a second case.
CREATE TABLE error_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  area TEXT NOT NULL,
  site_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  release TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'error',
  code TEXT NOT NULL DEFAULT '',
  module TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT '',
  stack TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  breadcrumbs TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  operation_id TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  job_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  UNIQUE(sender_id, event_id)
);
CREATE INDEX error_events_group ON error_events(group_id, received_at);
CREATE INDEX error_events_received ON error_events(received_at);
CREATE INDEX error_events_site ON error_events(site_id, received_at);
CREATE INDEX error_events_source ON error_events(area, source);
CREATE INDEX error_events_code ON error_events(code);

-- Saved diagnostic examples survive TTL with their card while protected.
CREATE TABLE error_examples (
  group_id TEXT NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL REFERENCES error_events(seq) ON DELETE CASCADE,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, event_seq)
);
CREATE INDEX error_examples_group ON error_examples(group_id);

-- Notes and status history travel with the protected card.
CREATE TABLE error_notes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX error_notes_group ON error_notes(group_id, seq);

CREATE TABLE error_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  author TEXT NOT NULL,
  change TEXT NOT NULL
);
CREATE INDEX error_history_group ON error_history(group_id, seq);

-- Tunable storage policy and runtime counters (last cleanup, queue pressure).
CREATE TABLE error_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO schema_migrations(version) VALUES(1);
