"""Diagnostics error-journal wire extension, kept separate from media-job payloads.

Receiving diagnostic events never creates a media job and does not depend on
connected compute devices. The site ingress trusts the existing site token; the
system area (source=worker) is only reachable through the dispatcher/processor
trusted channel. See docs/plan/error-journal-plan.md.
"""

VERSION = "2.0"


def ref(name):
    return {"$ref": f"#/$defs/{name}"}


def obj(properties, required):
    return {"type": "object", "properties": properties,
            "required": required, "additionalProperties": False}


def arr(item, minimum=0, maximum=10000, unique=False):
    result = {"type": "array", "items": item, "minItems": minimum, "maxItems": maximum}
    if unique:
        result["uniqueItems"] = True
    return result


def extend(d):
    # «Сбор ошибок» is a site-level permission: diagnostic ingress, not a media
    # job and not a compute capability. It belongs only to the site operation
    # list, not to JobRequest/OperationCapability.
    enum = d["AdminSite"]["properties"]["operations"]["items"]["enum"]
    if "diagnostics.collect" not in enum:
        enum.append("diagnostics.collect")
    for name in ("AdminSite", "AdminSiteView"):
        d[name]["properties"]["operations"]["maxItems"] = 5
    d["AdminSiteView"]["properties"]["diagnosticsLastReceivedAt"] = {
        "type": ["string", "null"], "format": "date-time",
    }

    short = {"type": "string", "maxLength": 1000}
    required_text = {"type": "string", "minLength": 1, "maxLength": 1000}
    d["DiagnosticsBreadcrumb"] = obj({
        "at": {"type": "string", "format": "date-time"},
        "category": short,
        "message": {"type": "string", "minLength": 1, "maxLength": 2048},
        "data": {"type": "string", "maxLength": 4096},
    }, ["at", "message"])

    d["DiagnosticsEvent"] = obj({
        "eventId": required_text,
        "occurredAt": {"type": "string", "format": "date-time"},
        "source": {"enum": ["front", "back", "worker"]},
        "service": short,
        "environment": short,
        "release": short,
        "severity": {"enum": ["fatal", "error", "warning", "info"]},
        "code": short,
        "module": short,
        "operation": short,
        "stage": short,
        "message": {"type": "string", "minLength": 1, "maxLength": 2048},
        "cause": {"type": "string", "maxLength": 4096},
        "stack": {"type": "string", "maxLength": 32768},
        "context": {"type": "string", "maxLength": 16384},
        "breadcrumbs": arr(ref("DiagnosticsBreadcrumb"), 0, 20),
        "requestId": short,
        "operationId": short,
        "resourceId": short,
        "jobId": short,
        "deviceId": short,
    }, ["eventId", "occurredAt", "source", "message"])

    d["DiagnosticsBatch"] = obj({
        "protocolVersion": {"const": VERSION},
        "events": arr(ref("DiagnosticsEvent"), 1, 50),
    }, ["protocolVersion", "events"])

    d["DiagnosticsAck"] = obj({
        "protocolVersion": {"const": VERSION},
        "accepted": {"type": "integer", "minimum": 0, "maximum": 50},
        "duplicates": {"type": "integer", "minimum": 0, "maximum": 50},
        "receivedAt": {"type": "string", "format": "date-time"},
    }, ["protocolVersion", "accepted", "duplicates", "receivedAt"])

    nonneg = {"type": "integer", "minimum": 0}
    d["DiagnosticsStatus"] = obj({
        "events": nonneg,
        "groups": nonneg,
        "dbBytes": nonneg,
        "freeBytes": nonneg,
        "maxDbBytes": nonneg,
        "protectedExamples": nonneg,
        "protectedBytes": nonneg,
        "lostQuota": nonneg,
        "lostDisk": nonneg,
        "lostSpam": nonneg,
        "lostFallback": nonneg,
        "retentionDays": {"type": "integer", "minimum": 7, "maximum": 21},
        "diskWarning": {"type": "boolean"},
        "lastPruneAt": {"type": ["string", "null"], "format": "date-time"},
        "lastPruneError": {"type": "string", "maxLength": 1000},
        "lastPruneRemoved": nonneg,
    }, ["events", "groups", "dbBytes", "freeBytes", "maxDbBytes", "protectedExamples",
        "protectedBytes", "lostQuota", "lostDisk", "lostSpam", "lostFallback",
        "retentionDays", "diskWarning", "lastPruneAt", "lastPruneError", "lastPruneRemoved"])

    d["DiagnosticsProbe"] = obj({
        "ok": {"type": "boolean"},
        "collectionEnabled": {"type": "boolean"},
        "journalAvailable": {"type": "boolean"},
        "probedAt": {"type": "string", "format": "date-time"},
        "lastReceivedAt": {"type": ["string", "null"], "format": "date-time"},
    }, ["ok", "collectionEnabled", "journalAvailable", "probedAt", "lastReceivedAt"])

    d["DiagnosticsSettings"] = obj({
        "retentionDays": {"type": "integer", "minimum": 7, "maximum": 21},
    }, ["retentionDays"])
    d["DiagnosticsSettingsView"] = obj({
        "retentionDays": {"type": "integer", "minimum": 7, "maximum": 21},
        "ttlAppliesOnNextPrune": {"type": "boolean"},
        "maxSavedExamples": {"type": "integer", "minimum": 1},
        "maxDbBytes": nonneg,
        "warning": {"type": "string", "maxLength": 1000},
    }, ["retentionDays", "ttlAppliesOnNextPrune", "maxSavedExamples", "maxDbBytes", "warning"])

    d["DiagnosticsNote"] = obj({
        "at": {"type": "string", "format": "date-time"},
        "author": short,
        "text": {"type": "string", "minLength": 1, "maxLength": 4000},
    }, ["at", "author", "text"])
    d["DiagnosticsNoteCreate"] = obj({
        "text": {"type": "string", "minLength": 1, "maxLength": 4000},
    }, ["text"])
    d["DiagnosticsHistory"] = obj({
        "at": {"type": "string", "format": "date-time"},
        "author": short,
        "change": short,
    }, ["at", "change"])

    stored = {
        "seq": {"type": "integer", "minimum": 1},
        "eventId": required_text,
        "occurredAt": {"type": "string", "format": "date-time"},
        "receivedAt": {"type": "string", "format": "date-time"},
        "source": {"enum": ["front", "back", "worker"]},
        "service": short, "environment": short, "release": short,
        "severity": {"enum": ["fatal", "error", "warning", "info"]},
        "code": short, "module": short, "operation": short, "stage": short,
        "message": {"type": "string", "minLength": 1, "maxLength": 2048},
        "cause": {"type": "string", "maxLength": 4096},
        "stack": {"type": "string", "maxLength": 32768},
        "context": {"type": "string", "maxLength": 16384},
        "breadcrumbs": arr(ref("DiagnosticsBreadcrumb"), 0, 20),
        "requestId": short, "operationId": short, "resourceId": short,
        "jobId": short, "deviceId": short, "pinned": {"type": "boolean"},
    }
    d["DiagnosticsStoredEvent"] = obj(stored, ["seq", "eventId", "occurredAt", "receivedAt",
                                               "source", "message", "pinned"])

    d["DiagnosticsGroupListItem"] = obj({
        "id": required_text,
        "title": {"type": "string", "minLength": 1, "maxLength": 240},
        "area": {"enum": ["sites", "worker"]},
        "siteId": short,
        "source": {"enum": ["front", "back", "worker"]},
        "code": short, "module": short,
        "status": {"enum": ["NEW", "IN_PROGRESS", "RESOLVED", "IGNORED"]},
        "favorite": {"type": "boolean"},
        "periodCount": nonneg,
        "lifetimeCount": nonneg,
        "firstSeenAt": {"type": "string", "format": "date-time"},
        "lastSeenAt": {"type": "string", "format": "date-time"},
        "protected": {"type": "boolean"},
    }, ["id", "title", "area", "source", "status", "favorite", "periodCount",
        "lifetimeCount", "lastSeenAt", "protected"])

    d["DiagnosticsSummary"] = obj({
        "cases": nonneg,
        "groups": nonneg,
        "newGroups": nonneg,
    }, ["cases", "groups", "newGroups"])

    d["DiagnosticsGroupPage"] = obj({
        "area": {"enum": ["sites", "worker"]},
        "from": {"type": ["string", "null"], "format": "date-time"},
        "to": {"type": ["string", "null"], "format": "date-time"},
        "summary": ref("DiagnosticsSummary"),
        "items": arr(ref("DiagnosticsGroupListItem"), 0, 50),
        "limit": {"type": "integer", "enum": [10, 25, 50]},
        "nextCursor": {"type": ["string", "null"]},
        "diskWarning": {"type": "boolean"},
    }, ["area", "from", "to", "summary", "items", "limit", "nextCursor", "diskWarning"])

    d["DiagnosticsGroupCard"] = obj({
        **d["DiagnosticsGroupListItem"]["properties"],
        "protectedExamples": nonneg,
        "latest": ref("DiagnosticsStoredEvent"),
        "examples": arr(ref("DiagnosticsStoredEvent"), 0, 10),
        "repeats": arr(ref("DiagnosticsStoredEvent"), 0, 20),
        "related": arr(ref("DiagnosticsStoredEvent"), 0, 20),
        "notes": arr(ref("DiagnosticsNote"), 0, 100),
        "history": arr(ref("DiagnosticsHistory"), 0, 200),
        "report": {"type": "string", "minLength": 1},
    }, d["DiagnosticsGroupListItem"]["required"] + ["protectedExamples", "latest",
                                                    "examples", "repeats", "related",
                                                    "notes", "history", "report"])

    d["DiagnosticsFavorite"] = obj({
        "favorite": {"type": "boolean"},
        "confirmUnprotect": {"type": "boolean"},
    }, ["favorite"])
    d["DiagnosticsStatusChange"] = obj({
        "status": {"enum": ["NEW", "IN_PROGRESS", "RESOLVED", "IGNORED"]},
        "confirmUnprotect": {"type": "boolean"},
    }, ["status"])
    d["DiagnosticsExamplePin"] = obj({"seq": {"type": "integer", "minimum": 1}}, ["seq"])
    d["DiagnosticsProtectResult"] = obj({
        "ok": {"type": "boolean"},
        "protectionRemoved": {"type": "boolean"},
        "warning": {"type": "string", "maxLength": 1000},
        "retentionDays": {"type": "integer", "minimum": 7, "maximum": 21},
    }, ["ok", "protectionRemoved", "warning", "retentionDays"])
    d["DiagnosticsPruneResult"] = obj({
        "removed": nonneg,
        "checkpoint": {"type": "boolean"},
        "diskWarning": {"type": "boolean"},
    }, ["removed", "checkpoint", "diskWarning"])
    d["DiagnosticsBackup"] = obj({
        "path": {"type": "string", "minLength": 1, "maxLength": 1000},
    }, ["path"])
