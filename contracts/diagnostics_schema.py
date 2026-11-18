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
