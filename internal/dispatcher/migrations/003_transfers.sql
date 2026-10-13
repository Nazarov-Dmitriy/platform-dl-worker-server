CREATE TABLE transfers (
 id TEXT PRIMARY KEY,
 job_seq INTEGER NOT NULL REFERENCES jobs(seq),
 device_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('SOURCE','UPLOAD')),
 assignment_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 epoch TEXT NOT NULL,
 source_revision TEXT,
 artifact BLOB,
 status TEXT NOT NULL CHECK(status IN ('OPEN','COMPLETED','CANCELLED')),
 created_at INTEGER NOT NULL,
 UNIQUE(job_seq, kind, assignment_id)
);
CREATE INDEX transfers_job ON transfers(job_seq, status);
CREATE TABLE transfer_pages (
 request_id TEXT NOT NULL REFERENCES transfers(id),
 page INTEGER NOT NULL,
 last_page INTEGER NOT NULL,
 mapping_fp TEXT NOT NULL,
 links BLOB NOT NULL,
 delivered INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(request_id, page)
);
CREATE TABLE publications (
 job_seq INTEGER PRIMARY KEY REFERENCES jobs(seq),
 claim_id TEXT NOT NULL UNIQUE,
 claim BLOB NOT NULL,
 decision BLOB,
 delivered INTEGER NOT NULL DEFAULT 0
);
INSERT INTO schema_migrations(version) VALUES(3);
