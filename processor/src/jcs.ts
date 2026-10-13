import { createHash } from "node:crypto";
export function canonicalize(value: unknown): string {
  return write(value);
}
export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
function write(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map((item) => write(item)).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as object)
      .filter(
        (key) => (value as Record<string, unknown>)[key] !== undefined,
      )
      .sort();
    return (
      "{" +
      keys
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            write((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  }
  throw new Error("JCS_TYPE");
}
