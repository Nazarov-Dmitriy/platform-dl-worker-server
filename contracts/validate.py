"""Offline checks of contract schemas, examples and declared design invariants."""
from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
CHECKER = FormatChecker()


@CHECKER.checks("date-time", raises=ValueError)
def timestamp(value):
    # Avoid optional format packages; wire timestamps require explicit timezone.
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value):
        return False
    return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def canonical(value):
    # Fixture strings/keys are ASCII; numbers are integers. Runtime must use RFC8785.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def semantic(definition, value):
    if definition == "Manifest":
        files = value["files"]
        paths = [f["path"] for f in files]
        assert len(paths) == len(set(paths)), "Duplicate manifest paths"
        for f in files:
            if f["kind"] == "SUBTITLE":
                assert "language" in f, "Subtitle language missing"
        if "masterPath" in value:
            assert value["masterPath"] in paths, "Master file missing"
            assert next(f for f in files if f["path"] == value["masterPath"])["kind"] == "MASTER"
        for rendition in value.get("renditions", []):
            assert rendition["playlist"] in paths, "Referenced playlist missing"
            assert next(f for f in files if f["path"] == rendition["playlist"])["kind"] == "PLAYLIST"
        steps = [(s["name"], s.get("language")) for s in value["steps"]]
        assert len(steps) == len(set(steps)), "Duplicate step outcome"
    elif definition == "Artifact":
        semantic("Manifest", value["manifest"])
        assert sha256(canonical(value["manifest"])).hexdigest() == value["manifestSha256"], "Manifest hash mismatch"
    elif definition == "JobRequest":
        sub = value["params"].get("subtitles") if value["type"] == "media.transcode" else (
            value["params"] if value["type"] == "media.subtitles" else None)
        if sub is not None:
            assert sub["includeOriginal"] or sub["targetLanguages"], "No requested subtitle output"
        if value["source"]["kind"] == "HLS":
            parts = value["source"]["files"]
            assert len({p["path"] for p in parts}) == len(parts), "Duplicate source path"
            assert sum(p["bytes"] for p in parts) == value["source"]["bytes"]
            assert sha256(canonical(sorted(parts, key=lambda p: p["path"]))).hexdigest() == value["source"]["sha256"]
    elif definition == "JobView":
        if "artifact" in value:
            semantic("Artifact", value["artifact"])
            assert value["steps"] == value["artifact"]["manifest"]["steps"]
        if value["status"] == "SUCCEEDED":
            assert all(s["status"] == "SUCCEEDED" for s in value["steps"]), "Success contains failed/pending step"
        if value["status"] == "PARTIAL":
            assert any(s["status"] == "SUCCEEDED" for s in value["steps"])
            assert any(s["status"] in ["FAILED", "SKIPPED"] for s in value["steps"])
    elif definition == "TransferGrant":
        paths = [f["path"] for f in value["links"]]
        assert len(paths) == len(set(paths)), "Duplicate grant path"
    elif definition == "DeviceMessage":
        body = value["body"]
        if value["type"] == "session.welcome":
            assert body["leaseSeconds"] > body["heartbeatSeconds"] + body["stopSafetySeconds"]
        if "artifact" in body:
            semantic("Artifact", body["artifact"])
            assert body["fence"] == body["artifact"]["fence"]
        if "grant" in body:
            semantic("TransferGrant", body["grant"])
            assert body["fence"] == body["grant"]["fence"]


def references(value):
    if isinstance(value, dict):
        if "$ref" in value:
            yield value["$ref"]
        for item in value.values():
            yield from references(item)
    elif isinstance(value, list):
        for item in value:
            yield from references(item)


def main():
    schema = load(ROOT / "v2/protocol.schema.json")
    Draft202012Validator.check_schema(schema)
    definitions = schema["$defs"]
    for target in references(schema):
        assert target.startswith("#/$defs/") and target.split("/")[-1] in definitions, target
    counts = {}
    for category in ["valid", "invalid", "semantic-invalid"]:
        counts[category] = 0
        for path in sorted((ROOT / f"fixtures/{category}").glob("*.json")):
            example = load(path)
            name = example["schema"]
            validator = Draft202012Validator({"$ref": f"#/$defs/{name}", "$defs": definitions}, format_checker=CHECKER)
            errors = list(validator.iter_errors(example["value"]))
            if category == "invalid":
                assert errors, f"Invalid shape unexpectedly accepted: {path.name}"
            else:
                assert not errors, f"{path.name}: {errors[0].message if errors else ''}"
                failed = False
                try:
                    semantic(name, example["value"])
                except AssertionError:
                    failed = True
                assert failed == (category == "semantic-invalid"), f"Semantic expectation failed: {path.name}"
            counts[category] += 1
    api = load(ROOT / "v2/openapi.json")
    assert api["openapi"] == "3.1.0"
    for target in references(api):
        assert target.startswith("./protocol.schema.json#/$defs/") and target.split("/")[-1] in definitions, target
    operations = set()
    for path, methods in api["paths"].items():
        needed = set(re.findall(r"\{([^}]+)\}", path))
        actual = {p["name"] for p in methods.get("parameters", []) if p["in"] == "path" and p["required"]}
        assert needed == actual, path
        for method, operation in methods.items():
            if method == "parameters":
                continue
            assert operation["operationId"] not in operations
            operations.add(operation["operationId"])
            for scheme in operation["security"]:
                assert all(s in api["components"]["securitySchemes"] for s in scheme)
    scenarios = load(ROOT / "fixtures/scenarios.json")
    for trace in scenarios["traces"]:
        states = trace["states"]
        allowed = all(b in scenarios["transitions"][a] for a, b in zip(states, states[1:]))
        assert allowed == trace["valid"], trace["name"]
    for case in scenarios["leaseCases"]:
        valid = (case["currentGeneration"] == case["messageGeneration"]
                 and case["currentEpoch"] == case["messageEpoch"] and case["now"] < case["expiresAt"])
        assert valid == case["accepted"], case["name"]
    for case in scenarios["monotonicDeadlineCases"]:
        deadline = case["sentAt"] + case["leaseSeconds"] - case["safety"]
        assert deadline == case["expectedLocalDeadline"]
        assert (case["receivedGrantAt"] < deadline) == case["mayStart"]
    defaults = load(ROOT / "v2/defaults.json")
    assert defaults["leaseSeconds"] > defaults["heartbeatSeconds"] + defaults["stopSafetySeconds"]
    assert defaults["transferRetriesAfterFirstAttempt"] == len(defaults["transferRetryBackoffSeconds"])
    assert defaults["maxManifestFiles"] == definitions["Manifest"]["properties"]["files"]["maxItems"]
    assert defaults["transferGrantPageSize"] == definitions["TransferGrant"]["properties"]["links"]["maxItems"]
    print(f"OK: schemas, {len(operations)} HTTP operations/references, {counts}, "
          f"{len(scenarios['traces'])} state traces, {len(scenarios['leaseCases'])} lease cases, "
          f"{len(scenarios['monotonicDeadlineCases'])} delayed-grant cases")
    print("These checks validate contract artifacts only; use Go tests for implemented runtime invariants.")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
