"""Generation wire extension. Preserve the existing media contracts."""
from copy import deepcopy


def extend(d):
    # Operation enums are shared by the builder, but independent in generated JSON.
    def visit(value):
        if isinstance(value, dict):
            if value.get("enum") == ["media.transcode", "media.transcribe", "media.subtitles"]:
                value["enum"].append("media.generate")
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(d)
    text = {"type": "string", "minLength": 1, "maxLength": 1000}
    number = {"type": "number", "minimum": -9007199254740991, "maximum": 9007199254740991}
    def obj(properties, required):
        return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}
    scalar = {"type": ["string", "number", "boolean"], "maxLength": 4000}
    d["GenerationParameter"] = obj({
        "key": {"type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9_]{0,63}$"},
        "label": text, "type": {"enum": ["string", "integer", "number", "boolean"]},
        "required": {"type": "boolean"}, "default": scalar,
        "minimum": number, "maximum": number,
        "step": {"type": "number", "exclusiveMinimum": 0},
        "maxLength": {"type": "integer", "minimum": 1, "maximum": 4000},
        "options": {"type": "array", "items": scalar, "minItems": 1, "maxItems": 64, "uniqueItems": True},
    }, ["key", "label", "type", "required"])
    d["GenerationModel"] = obj({
        "id": text, "revision": text, "profileRevision": text, "name": text, "description": text,
        "parameterCount": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
        "acceptsReference": {"type": "boolean"},
        "parameters": {"type": "array", "items": {"$ref": "#/$defs/GenerationParameter"}, "minItems": 1, "maxItems": 32},
    }, ["id", "revision", "profileRevision", "name", "description", "acceptsReference", "parameters"])
    models = {"type": "array", "items": {"$ref": "#/$defs/GenerationModel"}, "maxItems": 100}
    d["GenerationModelPage"] = obj({"protocolVersion": {"const": "2.0"}, "models": models}, ["protocolVersion", "models"])
    cap = d["OperationCapability"]["properties"]
    cap["generationModels"] = models
    cap["formats"]["items"]["enum"] = list(dict.fromkeys(cap["formats"]["items"]["enum"] + ["png"]))
    for definition in ("Capabilities", "AdminSite", "AdminSiteView", "ModelEntry", "CatalogRequest"):
        fields = d.get(definition, {}).get("properties", {})
        if "operations" in fields:
            fields["operations"]["maxItems"] = 4
    # Device hello, heartbeat and admin device views also carry capability arrays.
    def limits(value):
        if isinstance(value, dict):
            if value.get("items") == {"$ref": "#/$defs/OperationCapability"}:
                value["maxItems"] = 4
            for child in value.values(): limits(child)
        elif isinstance(value, list):
            for child in value: limits(child)
    limits(d)
    first = d["JobRequest"]["oneOf"][0]
    props = deepcopy(first["properties"])
    props["type"] = {"const": "media.generate"}
    props["maxDurationSeconds"] = {"type": "integer", "minimum": 1, "maximum": 3600}
    props["maxOutputBytes"] = {"type": "integer", "minimum": 1, "maximum": 1073741824}
    props["params"] = obj({"modelId": text, "modelRevision": text, "profileRevision": text,
                           "inputs": {"type": "object", "maxProperties": 32, "additionalProperties": scalar}},
                          ["modelId", "modelRevision", "profileRevision", "inputs"])
    # Image references use the existing verified FILE transfer protocol.
    props["source"] = {"$ref": "#/$defs/Source"}
    if not any(v["properties"]["type"].get("const") == "media.generate" for v in d["JobRequest"]["oneOf"]):
        d["JobRequest"]["oneOf"].append(obj(props, [k for k in first["required"] if k != "source"]))
    if "IMAGE" not in d["File"]["properties"]["kind"]["enum"]:
        d["File"]["properties"]["kind"]["enum"].append("IMAGE")
    # Stages are inline in several definitions.
    def stages(value):
        if isinstance(value, dict):
            enum = value.get("enum", [])
            if "TRANSCODING" in enum and "WAITING_UPLOAD" in enum and "GENERATING" not in enum:
                enum.append("GENERATING")
            for child in value.values(): stages(child)
        elif isinstance(value, list):
            for child in value: stages(child)
    stages(d)


if __name__ == "__main__":
    import json
    from pathlib import Path
    path = Path(__file__).parent / "v2/protocol.schema.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    extend(doc["$defs"])
    path.write_bytes((json.dumps(doc, ensure_ascii=False, indent=2) + "\n").replace("\n", "\r\n").encode())
