"""Build versioned design artifacts; this is not dispatcher/processor runtime code."""
from copy import deepcopy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = "2.0"
UUID = {"type": "string", "format": "uuid"}
DATE = {"type": "string", "format": "date-time"}
TEXT = {"type": "string", "minLength": 1, "maxLength": 1000}
LANG = {"type": "string", "pattern": r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$"}
HASH = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
BYTES = {"type": "integer", "minimum": 0, "maximum": 9007199254740991}
PATH = {"type": "string", "maxLength": 240,
        "pattern": r"^(?!.*(?:^|/)\.{1,2}(?:/|$))[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$"}
OP = {"enum": ["media.transcode", "media.transcribe", "media.subtitles"]}
STAGE = {"enum": ["WAITING_SOURCE", "DOWNLOADING", "ANALYZING", "TRANSCODING",
                   "TRANSCRIBING", "TRANSLATING", "PACKAGING", "WAITING_UPLOAD",
                   "UPLOADING", "WAITING_PUBLICATION", "STOPPING"]}


def ref(name):
    return {"$ref": f"#/$defs/{name}"}


def obj(properties, required=None):
    return {"type": "object", "properties": properties,
            "required": list(properties) if required is None else required,
            "additionalProperties": False}


def arr(item, minimum=0, maximum=10000, unique=False):
    result = {"type": "array", "items": item, "minItems": minimum, "maxItems": maximum}
    if unique:
        result["uniqueItems"] = True
    return result


def const(value):
    return {"const": value}


def msg(kind, body, direction):
    return obj({"protocolVersion": const(VERSION), "messageId": UUID,
                "type": const(kind), "direction": const(direction), "body": body})


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build():
    d = {}
    d["Error"] = obj({"code": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,63}$"},
                      "message": TEXT, "permanent": {"type": "boolean"},
                      "retryAfterSeconds": {"type": "integer", "minimum": 0}},
                     ["code", "message", "permanent"])
    d["Fence"] = obj({"assignmentId": UUID, "generation": {"type": "integer", "minimum": 1},
                      "dispatcherEpoch": UUID})
    d["SourcePart"] = obj({"path": PATH, "objectName": TEXT, "bytes": BYTES, "sha256": HASH})
    d["Source"] = obj({"objectName": TEXT, "revision": UUID, "bytes": BYTES,
                       "sha256": HASH, "contentType": TEXT,
                       "role": {"enum": ["UPLOAD", "PUBLISHED_MEDIA"]},
                       "kind": {"enum": ["FILE", "HLS"]},
                       "files": arr(ref("SourcePart"), 1) },
                      ["objectName", "revision", "bytes", "sha256", "contentType", "role", "kind"])
    d["Source"]["allOf"] = [{"if": {"properties": {"kind": const("HLS")}},
                               "then": {"required": ["files"]},
                               "else": {"not": {"required": ["files"]}}}]
    d["Profile"] = obj({
        "policyVersion": const("site-hls-2026-10-01"),
        "qualities": arr({"enum": ["P480", "P720", "P1080"]}, 1, 3, True),
        "segmentDurationSeconds": {"type": "integer", "minimum": 1, "maximum": 30},
        "codec": const("h264"), "encoderPolicy": {"enum": ["X264_EXACT", "HARDWARE_ALLOWED"]},
        "preset": {"enum": ["ultrafast", "superfast", "veryfast", "faster", "fast",
                            "medium", "slow", "slower", "veryslow"]},
        "crf": {"type": "integer", "minimum": 0, "maximum": 51},
        "audioBitrateKbps": {"type": "integer", "minimum": 1, "maximum": 512},
        "audioChannels": {"enum": [1, 2]},
        "targetVideoBitrateKbps": obj({q: {"type": "integer", "minimum": 1, "maximum": 100000}
                                      for q in ["P480", "P720", "P1080"]}),
        "passthroughTolerancePercent": {"type": "integer", "minimum": 0, "maximum": 100},
        "allowUpscale": const(False)})
    d["SpeechParams"] = obj({"sourceLanguage": {"oneOf": [const("auto"), LANG]},
                             "mode": {"enum": ["FAST", "QUALITY", "AUTO"]}})
    d["SubtitleParams"] = obj({"speech": ref("SpeechParams"), "includeOriginal": {"type": "boolean"},
                               "targetLanguages": arr(LANG, 0, 100, True),
                               "formats": arr({"enum": ["vtt", "srt"]}, 1, 2, True)})
    base = {"protocolVersion": const(VERSION), "id": UUID, "source": ref("Source"),
            "maxOutputBytes": {**BYTES, "minimum": 1},
            "maxDurationSeconds": {"type": "integer", "minimum": 1},
            "clientReference": TEXT}
    variants = []
    for operation, params in [
        ("media.transcode", obj({"profile": ref("Profile"), "subtitles": ref("SubtitleParams")}, ["profile"])),
        ("media.transcribe", ref("SpeechParams")),
        ("media.subtitles", ref("SubtitleParams")),
    ]:
        variants.append(obj({**base, "type": const(operation), "params": params},
                            ["protocolVersion", "id", "source", "maxOutputBytes",
                             "maxDurationSeconds", "type", "params"]))
    d["JobRequest"] = {"oneOf": variants}
    d["Step"] = {"oneOf": [
        obj({"name": TEXT, "language": LANG, "status": const(status),
             **({"error": ref("Error")} if status in ["FAILED", "SKIPPED"] else {})},
            ["name", "status"] + (["error"] if status in ["FAILED", "SKIPPED"] else []))
        for status in ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]
    ]}
    d["File"] = obj({"path": PATH, "bytes": BYTES, "sha256": HASH,
                     "contentType": TEXT,
                     "kind": {"enum": ["MASTER", "PLAYLIST", "SEGMENT", "SUBTITLE", "TRANSCRIPT"]},
                     "language": LANG}, ["path", "bytes", "sha256", "contentType", "kind"])
    d["Rendition"] = obj({"quality": {"enum": ["P480", "P720", "P1080"]},
                          "width": {"type": "integer", "minimum": 2},
                          "height": {"type": "integer", "minimum": 2},
                          "bandwidth": {"type": "integer", "minimum": 1},
                          "mode": {"enum": ["COPY", "ENCODE"]}, "playlist": PATH})
    d["Manifest"] = obj({"files": arr(ref("File"), 1), "steps": arr(ref("Step"), 1, 250),
                         "detectedLanguage": LANG, "masterPath": PATH,
                         "renditions": arr(ref("Rendition"), 1, 3)}, ["files", "steps"])
    d["Artifact"] = obj({"id": UUID, "manifestSha256": HASH, "fence": ref("Fence"),
                         "manifest": ref("Manifest")})
    d["TransferRequest"] = {"oneOf": [
        obj({"id": UUID, "kind": const("SOURCE"), "fence": ref("Fence"),
             "sourceRevision": UUID}),
        obj({"id": UUID, "kind": const("UPLOAD"), "fence": ref("Fence"),
             "artifact": ref("Artifact")}),
    ]}
    d["Link"] = obj({"path": PATH, "objectName": TEXT, "url": {"type": "string", "format": "uri"},
                     "expiresAt": DATE, "method": {"enum": ["GET", "PUT"]},
                     "headers": {"type": "object", "additionalProperties": {"type": "string"}}})
    d["TransferGrant"] = obj({"protocolVersion": const(VERSION), "requestId": UUID,
                              "fence": ref("Fence"), "links": arr(ref("Link"), 1, 256),
                              "page": {"type": "integer", "minimum": 0},
                              "lastPage": {"type": "boolean"}})
    d["Mutation"] = obj({"protocolVersion": const(VERSION), "requestId": UUID,
                         "reason": TEXT})
    d["MutationAck"] = obj({"protocolVersion": const(VERSION), "requestId": UUID,
                            "applied": const(True)})
    d["PublicationDecision"] = {"oneOf": [
        obj({"protocolVersion": const(VERSION), "artifactId": UUID, "fence": ref("Fence"),
             "manifestSha256": HASH, "decision": const("PUBLISHED"), "publicationId": UUID}),
        obj({"protocolVersion": const(VERSION), "artifactId": UUID, "fence": ref("Fence"),
             "manifestSha256": HASH, "decision": const("REJECTED"), "error": ref("Error")}),
    ]}
    d["PublicationAck"] = obj({"protocolVersion": const(VERSION), "artifactId": UUID,
                               "applied": const(True)})
    d["PublicationClaimRequest"] = obj({"protocolVersion": const(VERSION),
                                        "claimId": UUID, "artifactId": UUID,
                                        "manifestSha256": HASH, "fence": ref("Fence")})
    d["PublicationClaim"] = obj({"protocolVersion": const(VERSION), "claimId": UUID,
                                 "artifactId": UUID, "fence": ref("Fence"), "claimedAt": DATE})
    for decision in d["PublicationDecision"]["oneOf"]:
        decision["properties"]["claimId"] = UUID
        decision["required"].append("claimId")
    d["ReleaseReceipt"] = obj({"releaseId": UUID, "jobId": UUID, "releasedAt": DATE,
                               "dispatcherEpoch": UUID,
                               "scope": const("ALL_EXTERNAL_ATTEMPTS"),
                               "safeToRunLocally": const(True)})
    d["JobView"] = obj({
        "protocolVersion": const(VERSION), "id": UUID, "type": OP,
        "status": {"enum": ["QUEUED", "ASSIGNED", "RUNNING", "AWAITING_PUBLICATION", "PUBLISHING",
                            "CANCELLING", "RELEASING", "SUCCEEDED", "PARTIAL",
                            "FAILED", "REJECTED", "CANCELLED", "RELEASED"]},
        "revision": {"type": "integer", "minimum": 1}, "updatedAt": DATE,
        "progress": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
        "stage": STAGE, "lastProgressAt": DATE, "queueDelayed": {"type": "boolean"},
        "manualEntryOffered": {"type": "boolean"},
        "steps": arr(ref("Step"), 0, 250), "error": ref("Error"),
        "artifact": ref("Artifact"), "releaseReceipt": ref("ReleaseReceipt"),
        "publicationClaim": ref("PublicationClaim"),
        "actionable": {"type": "boolean"},
        "retryAfterSeconds": {"type": "integer", "minimum": 1},
    }, ["protocolVersion", "id", "type", "status", "revision", "updatedAt", "progress",
        "queueDelayed", "manualEntryOffered", "steps"])
    d["JobView"]["allOf"] = [
        {"if": {"properties": {"status": {"enum": ["FAILED", "REJECTED"]}}},
         "then": {"required": ["error"]}},
        {"if": {"properties": {"status": {"enum": ["SUCCEEDED", "PARTIAL", "AWAITING_PUBLICATION", "PUBLISHING"]}}},
         "then": {"required": ["artifact"]}},
        {"if": {"properties": {"status": const("PUBLISHING")}},
         "then": {"required": ["publicationClaim"]}},
        {"if": {"properties": {"status": const("RELEASED")}},
         "then": {"required": ["releaseReceipt"]}},
    ]
    d["TransferPage"] = obj({"protocolVersion": const(VERSION),
                             "requests": arr(ref("TransferRequest"), 0, 32),
                             "nextCursor": {"type": ["string", "null"]}})
    d["JobPage"] = obj({"protocolVersion": const(VERSION), "jobs": arr(ref("JobView"), 0, 100),
                        "nextCursor": {"type": ["string", "null"]}})
    d["LanguagePair"] = obj({"source": LANG, "target": LANG})
    d["OperationCapability"] = obj({"code": OP,
                                    "recognitionLanguages": arr(LANG, 0, 200, True),
                                    "translationDirections": arr(ref("LanguagePair"), 0, 10000, True),
                                    "autoDetect": {"type": "boolean"},
                                    "formats": arr({"enum": ["text", "vtt", "srt", "hls"]}, 1, 4, True),
                                    "availability": {"enum": ["ONLINE", "OFFLINE", "NOT_INSTALLED"]},
                                    "profilePolicies": arr({"enum": ["X264_EXACT", "HARDWARE_ALLOWED"]}, 0, 2, True)})
    d["Capabilities"] = obj({"protocolVersion": const(VERSION), "revision": TEXT,
                             "checkedAt": DATE, "operations": arr(ref("OperationCapability"), 0, 3)})
    d["Usage"] = obj({"cpuPercent": {"type": "number", "minimum": 0, "maximum": 100},
                      "memoryUsedPercent": {"type": "number", "minimum": 0, "maximum": 100},
                      "memoryPressure": {"enum": ["NORMAL", "HIGH", "UNKNOWN"]},
                      "diskUsedPercent": {"type": "number", "minimum": 0, "maximum": 100},
                      "freeMemoryBytes": BYTES, "freeDiskBytes": BYTES,
                      "freeVramBytes": {"type": ["integer", "null"], "minimum": 0},
                      "encoderBusyPercent": {"type": ["number", "null"], "minimum": 0, "maximum": 100},
                      "availableSlots": {"type": "integer", "minimum": 0, "maximum": 64},
                      "paused": {"type": "boolean"}, "workDiskAvailable": {"type": "boolean"}})
    d["ModelEntry"] = obj({"id": TEXT, "revision": TEXT, "executor": TEXT,
                           "purpose": {"enum": ["RECOGNITION", "TRANSLATION"]},
                           "os": arr({"enum": ["windows", "darwin", "linux"]}, 1, 3, True),
                           "architectures": arr({"enum": ["amd64", "arm64"]}, 1, 2, True),
                           "accelerators": arr({"enum": ["cpu", "cuda", "metal"]}, 1, 3, True),
                           "recognitionLanguages": arr(LANG, 0, 200, True),
                           "translationDirections": arr(ref("LanguagePair"), 0, 10000, True),
                           "downloadBytes": BYTES, "minimumRamBytes": BYTES, "minimumVramBytes": BYTES,
                           "sha256": HASH, "downloadUrl": {"type": "string", "format": "uri"},
                           "license": TEXT, "descriptionSource": {"type": "string", "format": "uri"}})
    d["AdminCommand"] = {"oneOf": [
        obj({"requestId": UUID, "type": const(kind), "modelId": TEXT, "modelRevision": TEXT})
        for kind in ["MODEL_INSTALL", "MODEL_ACTIVATE", "MODEL_DELETE"]
    ] + [obj({"requestId": UUID, "type": const("CONFIGURE"),
              "settings": obj({"workDirectory": TEXT, "paused": {"type": "boolean"},
                               "autostart": {"type": "boolean"},
                               "maxParallel": {"type": "integer", "minimum": 1, "maximum": 64},
                               "cpuThresholdPercent": {"type": "integer", "minimum": 1, "maximum": 100},
                               "memoryThresholdPercent": {"type": "integer", "minimum": 1, "maximum": 100},
                               "diskThresholdPercent": {"type": "integer", "minimum": 1, "maximum": 100}})})]}
    assignment = {"jobId": UUID, "fence": ref("Fence")}
    messages = {
        "device.hello": (obj({"deviceId": UUID, "agentVersion": TEXT,
                              "os": {"enum": ["windows", "darwin", "linux"]},
                              "architecture": {"enum": ["amd64", "arm64"]},
                              "memoryBytes": BYTES, "cpuCores": {"type": "integer", "minimum": 1},
                              "accelerators": arr(TEXT, 0, 10, True),
                              "capabilities": arr(ref("OperationCapability"), 0, 3),
                              "usage": ref("Usage"), "active": arr(obj(assignment), 0, 64)}), "UP"),
        "session.welcome": (obj({"sessionId": UUID, "dispatcherEpoch": UUID,
                                 "heartbeatSeconds": {"type": "integer", "minimum": 1, "maximum": 300},
                                 "leaseSeconds": {"type": "integer", "minimum": 10, "maximum": 3600},
                                 "stopSafetySeconds": {"type": "integer", "minimum": 1, "maximum": 60}}), "DOWN"),
        "device.heartbeat": (obj({"usage": ref("Usage"), "capabilities": arr(ref("OperationCapability"), 0, 3)}), "UP"),
        "job.offer": (obj({**assignment, "offerExpiresAt": DATE, "job": ref("JobRequest")}), "DOWN"),
        "job.accept": (obj(assignment), "UP"),
        "job.decline": (obj({**assignment, "error": ref("Error")}), "UP"),
        "lease.granted": (obj({**assignment, "renewalId": UUID,
                               "leaseSeconds": {"type": "integer", "minimum": 10, "maximum": 3600},
                               "expiresAt": DATE}), "DOWN"),
        "job.status": (obj({**assignment, "renewalId": UUID, "stage": STAGE,
                            "progress": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
                            "activitySequence": {"type": "integer", "minimum": 0},
                            "steps": arr(ref("Step"), 0, 250)}), "UP"),
        "job.source.request": (obj(assignment), "UP"),
        "job.source.granted": (obj({**assignment, "grant": ref("TransferGrant")}), "DOWN"),
        "job.artifact.propose": (obj({**assignment, "artifact": ref("Artifact")}), "UP"),
        "job.upload.granted": (obj({**assignment, "grant": ref("TransferGrant")}), "DOWN"),
        "job.upload.complete": (obj({**assignment, "artifactId": UUID, "manifestSha256": HASH}), "UP"),
        "job.failed": (obj({**assignment, "error": ref("Error")}), "UP"),
        "job.stop": (obj({**assignment, "reason": TEXT}), "DOWN"),
        "job.stopped": (obj(assignment), "UP"),
        "job.publication.done": (obj({**assignment, "artifactId": UUID,
                                      "outcome": {"enum": ["SUCCEEDED", "PARTIAL"]}}), "DOWN"),
        "device.command": (ref("AdminCommand"), "DOWN"),
        "device.command.result": (obj({"requestId": UUID, "status": {"enum": ["RUNNING", "SUCCEEDED", "FAILED"]},
                                       "progress": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
                                       "error": ref("Error")}, ["requestId", "status", "progress"]), "UP"),
        "protocol.ack": (obj({"replyTo": UUID}), "DOWN"),
        "protocol.error": (obj({"replyTo": UUID, "error": ref("Error")}), "DOWN"),
    }
    d["DeviceMessage"] = {"oneOf": []}
    for kind, (body, direction) in messages.items():
        name = "Message_" + kind.replace(".", "_")
        d[name] = msg(kind, body, direction)
        d["DeviceMessage"]["oneOf"].append(ref(name))
    d["CommandView"] = obj({"requestId": UUID,
        "status": {"enum": ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]},
        "progress": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
        "error": ref("Error")}, ["requestId", "status", "progress"])
    d["CommandView"]["allOf"] = [{"if": {"properties": {"status": const("FAILED")}},
                                     "then": {"required": ["error"]}}]
    d["AdminSite"] = obj({"name": TEXT, "enabled": {"type": "boolean"},
                          "operations": arr(OP, 0, 3, True),
                          "weight": {"type": "integer", "minimum": 1, "maximum": 100}})
    d["AdminDevice"] = obj({"name": TEXT, "enabled": {"type": "boolean"}})
    d["AdminAccount"] = obj({"login": TEXT, "password": {"type": "string", "minLength": 12, "maxLength": 256},
                             "enabled": {"type": "boolean"},
                             "role": {"enum": ["OWNER", "OPERATOR"]},
                             "manageSites": {"type": "boolean"}})
    d["AdminAccountUpdate"] = obj({"login": TEXT, "password": {"type": "string", "minLength": 12, "maxLength": 256},
                                   "enabled": {"type": "boolean"},
                                   "role": {"enum": ["OWNER", "OPERATOR"]},
                                   "manageSites": {"type": "boolean"}}, ["login", "enabled", "role", "manageSites"])
    d["Login"] = obj({"login": TEXT, "password": {"type": "string", "minLength": 1, "maxLength": 256}})
    d["Session"] = obj({"accountId": UUID, "role": {"enum": ["OWNER", "OPERATOR"]},
                        "manageSites": {"type": "boolean"}, "csrfToken": TEXT})
    d["TokenCreate"] = obj({"requestId": UUID})
    d["IssuedToken"] = obj({"tokenId": UUID, "token": {"type": "string", "minLength": 32},
                            "purpose": {"enum": ["SITE", "DEVICE"]}})
    d["TokenView"] = obj({"tokenId": UUID, "purpose": {"enum": ["SITE", "DEVICE"]},
                          "principalId": UUID, "createdAt": DATE, "revoked": {"type": "boolean"}})
    d["TokenPage"] = obj({"items": arr(ref("TokenView"), 0, 100),
                          "nextCursor": {"type": ["string", "null"]}})
    d["AdminRecord"] = obj({"id": UUID, "revision": {"type": "integer", "minimum": 1}})
    d["AdminSiteView"] = obj({**d["AdminSite"]["properties"],
                              **d["AdminRecord"]["properties"], "tokenSet": {"type": "boolean"}})
    d["AdminDeviceView"] = obj({**d["AdminDevice"]["properties"], **d["AdminRecord"]["properties"],
                                "tokenSet": {"type": "boolean"},
                                "online": {"type": "boolean"}, "lastSeenAt": {"type": ["string", "null"], "format": "date-time"},
                                "usage": ref("Usage"), "capabilities": arr(ref("OperationCapability"), 0, 3)},
                               ["id", "name", "enabled", "revision", "tokenSet", "online", "lastSeenAt"])
    d["AdminAccountView"] = obj({**d["AdminRecord"]["properties"], "login": TEXT,
                                 "enabled": {"type": "boolean"},
                                 "role": {"enum": ["OWNER", "OPERATOR"]}, "manageSites": {"type": "boolean"}})
    for kind in ["Site", "Device", "Account"]:
        d[f"Admin{kind}Page"] = obj({"items": arr(ref(f"Admin{kind}View"), 0, 100),
                                    "nextCursor": {"type": ["string", "null"]}})
    d["AdminRecordPage"] = obj({"items": arr(ref("AdminRecord"), 0, 100),
                               "nextCursor": {"type": ["string", "null"]}})
    d["ModelPage"] = obj({"models": arr(ref("ModelEntry"), 0, 100),
                         "nextCursor": {"type": ["string", "null"]}})
    schema = {"$schema": "https://json-schema.org/draft/2020-12/schema",
              "$id": "https://worker.invalid/contracts/2.0/protocol.schema.json",
              "title": "Media worker protocol 2.0 (design contract)", "$defs": d}
    dump(ROOT / "v2/protocol.schema.json", schema)

    def sref(name):
        return {"$ref": f"./protocol.schema.json#/$defs/{name}"}

    def endpoint(operation_id, request, response, statuses, role="SiteToken"):
        item = {"operationId": operation_id, "security": [{role: []}],
                "responses": {str(code): {"description": "See normative protocol.md",
                              "content": {"application/json": {"schema": sref(response if code < 400 else "Error")}}}
                              for code in statuses}}
        if request:
            item["requestBody"] = {"required": True, "content": {"application/json": {"schema": sref(request)}}}
        return item

    paths = {}
    specs = [
        ("/api/v2/site/capabilities", "get", "getCapabilities", None, "Capabilities", [200, 401, 403]),
        ("/api/v2/site/jobs", "post", "submitJob", "JobRequest", "JobView", [200, 202, 400, 401, 403, 409, 413, 429, 503]),
        ("/api/v2/site/jobs", "get", "listJobs", None, "JobPage", [200, 401, 403]),
        ("/api/v2/site/jobs/{id}", "get", "getJob", None, "JobView", [200, 401, 403, 404, 410]),
        ("/api/v2/site/jobs/{id}/transfers", "get", "getTransfers", None, "TransferPage", [200, 401, 403, 404]),
        ("/api/v2/site/jobs/{id}/transfer-grants", "post", "grantTransfer", "TransferGrant", "MutationAck", [200, 401, 403, 404, 409]),
        ("/api/v2/site/jobs/{id}/publication-decision", "post", "decidePublication", "PublicationDecision", "PublicationAck", [200, 401, 403, 404, 409]),
        ("/api/v2/site/jobs/{id}/publication-claim", "post", "claimPublication", "PublicationClaimRequest", "PublicationClaim", [200, 401, 403, 404, 409]),
        ("/api/v2/site/jobs/{id}/cancel", "post", "cancelJob", "Mutation", "JobView", [200, 202, 401, 403, 404, 409]),
        ("/api/v2/site/jobs/{id}/release", "post", "releaseToSite", "Mutation", "JobView", [200, 202, 401, 403, 404, 409]),
    ]
    for path, method, oid, request, response, statuses in specs:
        paths.setdefault(path, {})[method] = endpoint(oid, request, response, statuses)
    for kind, request in [("sites", "AdminSite"), ("devices", "AdminDevice"), ("accounts", "AdminAccount")]:
        path = f"/api/v2/admin/{kind}"
        singular = {"sites": "Site", "devices": "Device", "accounts": "Account"}[kind]
        paths[path] = {"post": endpoint(f"create{kind.title()}", request, f"Admin{singular}View", [201, 400, 401, 403], "AdminSession"),
                       "get": endpoint(f"list{kind.title()}", None, f"Admin{singular}Page", [200, 401, 403], "AdminSession")}
        paths[path + "/{id}"] = {"put": endpoint(f"update{kind.title()}", "AdminAccountUpdate" if kind == "accounts" else request,
                                                  f"Admin{singular}View", [200, 400, 401, 403, 409, 428], "AdminSession")}
        paths[path + "/{id}"]["put"]["parameters"] = [{"name": "If-Match", "in": "header", "required": True,
                                                         "schema": {"type": "string", "pattern": '^"[1-9][0-9]*"$'}}]
        if kind != "accounts":
            paths[path + "/{id}/tokens"] = {"post": endpoint(f"issue{kind.title()}Token", "TokenCreate", "IssuedToken", [201, 401, 403, 409], "AdminSession")}
    paths["/api/v2/admin/tokens/{id}/revoke"] = {"post": endpoint("revokeToken", "Mutation", "MutationAck", [200, 401, 403], "AdminSession")}
    paths["/api/v2/admin/tokens"] = {"get": endpoint("listTokens", None, "TokenPage", [200, 401, 403], "AdminSession")}
    paths["/api/v2/admin/devices/{id}/commands"] = {"post": endpoint("deviceCommand", "AdminCommand", "MutationAck", [202, 400, 401, 403, 409], "AdminSession")}
    paths["/api/v2/admin/devices/{id}/commands/{requestId}"] = {"get": endpoint("getDeviceCommand", None, "CommandView", [200, 401, 403, 404], "AdminSession")}
    paths["/api/v2/admin/models"] = {"get": endpoint("listModels", None, "ModelPage", [200, 401, 403], "AdminSession")}
    paths["/api/v2/admin/session"] = {"post": endpoint("login", "Login", "Session", [200, 401, 429], "AdminSession"),
                                      "get": endpoint("session", None, "Session", [200, 401], "AdminSession"),
                                      "delete": {"operationId": "logout", "security": [{"AdminSession": []}], "responses": {"204": {"description": "Session revoked"}}}}
    paths["/api/v2/admin/session"]["post"]["security"] = []
    for path, methods in paths.items():
        if "{id}" in path:
            methods["parameters"] = [{"name": "id", "in": "path", "required": True, "schema": UUID}]
        if "{requestId}" in path:
            methods["parameters"].append({"name": "requestId", "in": "path", "required": True, "schema": UUID})
        if path.endswith("/jobs") or path.endswith("/transfers") or any(path.endswith("/" + k) for k in ["sites", "devices", "accounts", "models", "tokens"]):
            if "get" in methods:
                methods["get"]["parameters"] = [{"name": "cursor", "in": "query", "schema": {"type": "string"}},
                                                 {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 100}}]
    openapi = {"openapi": "3.1.0", "info": {"title": "Dispatcher design contract", "version": VERSION},
               "servers": [{"url": "https://dispatcher.example.invalid"}], "paths": paths,
               "components": {"securitySchemes": {
                   "SiteToken": {"type": "http", "scheme": "bearer"},
                   "DeviceToken": {"type": "http", "scheme": "bearer"},
                   "AdminSession": {"type": "apiKey", "in": "cookie", "name": "dispatcher_session"}}}}
    dump(ROOT / "v2/openapi.json", openapi)

    jid = "11111111-1111-4111-8111-111111111111"
    aid = "22222222-2222-4222-8222-222222222222"
    rid = "33333333-3333-4333-8333-333333333333"
    did = "44444444-4444-4444-8444-444444444444"
    epoch = "55555555-5555-4555-8555-555555555555"
    now = "2026-10-13T09:00:00Z"
    fence = {"assignmentId": aid, "generation": 1, "dispatcherEpoch": epoch}
    profile = {"policyVersion": "site-hls-2026-10-01", "qualities": ["P720", "P1080"],
               "segmentDurationSeconds": 6, "codec": "h264", "encoderPolicy": "X264_EXACT",
               "preset": "slow", "crf": 25, "audioBitrateKbps": 96, "audioChannels": 1,
               "targetVideoBitrateKbps": {"P480": 700, "P720": 1200, "P1080": 2500},
               "passthroughTolerancePercent": 20, "allowUpscale": False}
    speech = {"sourceLanguage": "auto", "mode": "AUTO"}
    subtitles = {"speech": speech, "includeOriginal": True, "targetLanguages": ["ru", "en"], "formats": ["vtt"]}
    job = {"protocolVersion": VERSION, "id": jid, "type": "media.transcode",
           "source": {"objectName": "uploads/video.mp4", "revision": rid, "bytes": 281919974,
                      "sha256": "a" * 64, "contentType": "video/mp4", "role": "UPLOAD", "kind": "FILE"},
           "params": {"profile": profile, "subtitles": subtitles},
           "maxOutputBytes": 1073741824, "maxDurationSeconds": 7200, "clientReference": "lesson-video-revision-1"}
    err = {"code": "TRANSLATION_UNAVAILABLE", "message": "Russian subtitle translation failed", "permanent": False}
    manifest = {"files": [{"path": "index.m3u8", "bytes": 120, "sha256": "b" * 64, "contentType": "application/vnd.apple.mpegurl", "kind": "MASTER"},
                          {"path": "720p/index.m3u8", "bytes": 100, "sha256": "c" * 64, "contentType": "application/vnd.apple.mpegurl", "kind": "PLAYLIST"},
                          {"path": "720p/seg_000.ts", "bytes": 1000, "sha256": "d" * 64, "contentType": "video/mp2t", "kind": "SEGMENT"},
                          {"path": "subtitles/en.vtt", "bytes": 80, "sha256": "e" * 64, "contentType": "text/vtt", "kind": "SUBTITLE", "language": "en"}],
                "steps": [{"name": "video", "status": "SUCCEEDED"},
                          {"name": "subtitles", "language": "en", "status": "SUCCEEDED"},
                          {"name": "subtitles", "language": "ru", "status": "FAILED", "error": err}],
                "detectedLanguage": "en", "masterPath": "index.m3u8",
                "renditions": [{"quality": "P720", "width": 1280, "height": 720, "bandwidth": 1011960,
                                "mode": "COPY", "playlist": "720p/index.m3u8"}]}
    from hashlib import sha256
    manifest_hash = sha256(canonical(manifest)).hexdigest()
    artifact = {"id": rid, "manifestSha256": manifest_hash, "fence": fence, "manifest": manifest}
    view = {"protocolVersion": VERSION, "id": jid, "type": job["type"], "status": "PARTIAL",
            "revision": 9, "updatedAt": now, "progress": 1, "queueDelayed": False,
            "manualEntryOffered": True, "steps": manifest["steps"], "artifact": artifact}
    usage = {"cpuPercent": 20, "memoryUsedPercent": 40, "memoryPressure": "NORMAL",
             "diskUsedPercent": 20, "freeMemoryBytes": 8589934592, "freeDiskBytes": 107374182400,
             "freeVramBytes": None, "encoderBusyPercent": None, "availableSlots": 1,
             "paused": False, "workDiskAvailable": True}
    cap = {"code": "media.transcode", "recognitionLanguages": ["en", "ru"],
           "translationDirections": [{"source": "en", "target": "ru"}], "autoDetect": True,
           "formats": ["hls", "vtt"], "availability": "ONLINE", "profilePolicies": ["X264_EXACT"]}
    link = {"path": "source", "objectName": "uploads/video.mp4",
            "url": "https://storage.example.invalid/source?signature=TEST_ONLY",
            "expiresAt": "2026-10-13T09:20:00Z", "method": "GET", "headers": {}}
    grant = {"protocolVersion": VERSION, "requestId": rid, "fence": fence, "links": [link], "page": 0, "lastPage": True}
    payloads = [
        ("job-video", "JobRequest", job),
        ("job-audio", "JobRequest", {**job, "type": "media.transcribe", "params": speech,
                                    "source": {**job["source"], "role": "PUBLISHED_MEDIA", "contentType": "audio/mpeg"}}),
        ("job-subtitles", "JobRequest", {**job, "type": "media.subtitles", "params": subtitles,
                                        "source": {**job["source"], "role": "PUBLISHED_MEDIA"}}),
        ("partial", "JobView", view),
        ("capabilities", "Capabilities", {"protocolVersion": VERSION, "revision": "1", "checkedAt": now, "operations": [cap]}),
        ("transfer-grant", "TransferGrant", grant),
        ("transfer-requests", "TransferPage", {"protocolVersion": VERSION,
          "requests": [{"id": rid, "kind": "SOURCE", "fence": fence, "sourceRevision": rid}], "nextCursor": None}),
        ("publication", "PublicationDecision", {"protocolVersion": VERSION, "artifactId": rid, "fence": fence,
          "manifestSha256": manifest_hash, "decision": "PUBLISHED", "publicationId": did, "claimId": aid}),
        ("publication-claim", "PublicationClaimRequest", {"protocolVersion": VERSION, "artifactId": rid,
          "fence": fence, "manifestSha256": manifest_hash, "claimId": aid}),
    ]
    bodies = {
        "device.hello": {"deviceId": did, "agentVersion": "0.1.0", "os": "darwin", "architecture": "arm64",
                         "memoryBytes": 17179869184, "cpuCores": 8, "accelerators": ["metal"],
                         "capabilities": [cap], "usage": usage, "active": []},
        "session.welcome": {"sessionId": rid, "dispatcherEpoch": epoch, "heartbeatSeconds": 15,
                            "leaseSeconds": 120, "stopSafetySeconds": 5},
        "device.heartbeat": {"usage": usage, "capabilities": [cap]},
        "job.offer": {"jobId": jid, "fence": fence, "offerExpiresAt": "2026-10-13T09:00:10Z", "job": job},
        "job.accept": {"jobId": jid, "fence": fence},
        "job.decline": {"jobId": jid, "fence": fence, "error": err},
        "lease.granted": {"jobId": jid, "fence": fence, "renewalId": rid, "leaseSeconds": 120, "expiresAt": "2026-10-13T09:02:00Z"},
        "job.status": {"jobId": jid, "fence": fence, "renewalId": rid, "stage": "TRANSCODING",
                       "progress": 0.5, "activitySequence": 20, "steps": [{"name": "video", "status": "RUNNING"}]},
        "job.source.request": {"jobId": jid, "fence": fence},
        "job.source.granted": {"jobId": jid, "fence": fence, "grant": grant},
        "job.artifact.propose": {"jobId": jid, "fence": fence, "artifact": artifact},
        "job.upload.granted": {"jobId": jid, "fence": fence,
                               "grant": {**grant, "links": [{**link, "path": f["path"],
                                  "objectName": f"jobs/site-test/{jid}/{epoch}/1/{aid}/" + f["path"],
                                  "method": "PUT"} for f in manifest["files"]]}},
        "job.upload.complete": {"jobId": jid, "fence": fence, "artifactId": rid, "manifestSha256": manifest_hash},
        "job.failed": {"jobId": jid, "fence": fence, "error": err},
        "job.stop": {"jobId": jid, "fence": fence, "reason": "Cancelled by site"},
        "job.stopped": {"jobId": jid, "fence": fence},
        "job.publication.done": {"jobId": jid, "fence": fence, "artifactId": rid, "outcome": "PARTIAL"},
        "device.command": {"requestId": rid, "type": "MODEL_INSTALL", "modelId": "recognition-example", "modelRevision": "test-only"},
        "device.command.result": {"requestId": rid, "status": "RUNNING", "progress": 0.5},
        "protocol.ack": {"replyTo": rid},
        "protocol.error": {"replyTo": rid, "error": err},
    }
    for kind, body in bodies.items():
        payloads.append((kind.replace(".", "-"), "DeviceMessage",
                         {"protocolVersion": VERSION, "messageId": rid, "type": kind,
                          "direction": messages[kind][1], "body": body}))
    bads = []
    for name, definition, value in payloads:
        dump(ROOT / f"fixtures/valid/{name}.json", {"schema": definition, "value": value})
    def bad(name, definition, value):
        bads.append((name, definition, value))
    changed = deepcopy(job); changed["params"]["profile"]["allowUpscale"] = True
    bad("upscale", "JobRequest", changed)
    changed = deepcopy(job); changed["params"]["profile"]["qualities"] = ["P720", "P720"]
    bad("duplicate-quality", "JobRequest", changed)
    changed = deepcopy(job); changed["params"]["profile"].pop("audioChannels")
    bad("incomplete-profile", "JobRequest", changed)
    changed = deepcopy(job); changed["params"]["command"] = "arbitrary-command"
    bad("os-command", "JobRequest", changed)
    changed = deepcopy(manifest); changed["files"][0]["path"] = "../other/index.m3u8"
    bad("path-traversal", "Manifest", changed)
    changed = deepcopy(view); changed.pop("artifact")
    bad("partial-without-artifact", "JobView", changed)
    changed = deepcopy(view); changed["status"] = "FAILED"; changed.pop("artifact")
    bad("failure-without-reason", "JobView", changed)
    changed = deepcopy(payloads[-1][2]); changed["protocolVersion"] = "3.0"
    bad("wrong-version", "DeviceMessage", changed)
    changed = deepcopy(grant); changed["links"][0]["expiresAt"] = "not-a-date"
    bad("invalid-expiry", "TransferGrant", changed)
    for name, definition, value in bads:
        dump(ROOT / f"fixtures/invalid/{name}.json", {"schema": definition, "value": value})
    semantic_bads = []
    def semantic_bad(name, definition, value):
        semantic_bads.append((name, definition, value))
    changed = deepcopy(manifest); changed["files"].append(deepcopy(changed["files"][0]))
    semantic_bad("duplicate-file-path", "Manifest", changed)
    changed = deepcopy(manifest); changed["files"][-1].pop("language")
    semantic_bad("subtitle-without-language", "Manifest", changed)
    changed = deepcopy(manifest); changed["renditions"][0]["playlist"] = "720p/missing.m3u8"
    semantic_bad("missing-playlist", "Manifest", changed)
    changed = deepcopy(artifact); changed["manifestSha256"] = "f" * 64
    semantic_bad("wrong-manifest-hash", "Artifact", changed)
    changed = deepcopy(job); changed["params"]["subtitles"]["includeOriginal"] = False
    changed["params"]["subtitles"]["targetLanguages"] = []
    semantic_bad("empty-subtitles", "JobRequest", changed)
    changed = deepcopy(view); changed["status"] = "SUCCEEDED"
    semantic_bad("success-with-failed-step", "JobView", changed)
    changed = deepcopy(grant); changed["links"].append(deepcopy(changed["links"][0]))
    semantic_bad("duplicate-grant-path", "TransferGrant", changed)
    for name, definition, value in semantic_bads:
        dump(ROOT / f"fixtures/semantic-invalid/{name}.json", {"schema": definition, "value": value})


def canonical(value):
    """Fixtures use ASCII JSON values. Production uses RFC 8785 JCS, see protocol.md."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


if __name__ == "__main__":
    build()
