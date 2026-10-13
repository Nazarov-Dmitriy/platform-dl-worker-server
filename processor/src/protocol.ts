import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
export type Fence = {
  assignmentId: string;
  generation: number;
  dispatcherEpoch: string;
};
export type Frame = {
  protocolVersion: "2.0";
  messageId: string;
  type: string;
  direction: "UP" | "DOWN";
  body: any;
};
const ajv = new Ajv2020({ strict: false, allErrors: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const schema = JSON.parse(
  readFileSync(new URL("./protocol.schema.json", import.meta.url), "utf8"),
);
ajv.addSchema(schema, "protocol");
const validate = ajv.compile({ $ref: "protocol#/$defs/DeviceMessage" });
export function parseFrame(raw: string, direction: "UP" | "DOWN"): Frame {
  const f: Frame = JSON.parse(raw);
  if (!validate(f) || f.direction !== direction)
    throw new Error("INVALID_PROTOCOL");
  return f;
}
export function frame(type: string, body: any): Frame {
  const f: Frame = {
    protocolVersion: "2.0",
    messageId: randomUUID(),
    type,
    direction: "UP",
    body,
  };
  if (!validate(f)) throw new Error("INVALID_OUTGOING_PROTOCOL");
  return f;
}
export const sameFence = (a: Fence, b: Fence) =>
  a.assignmentId === b.assignmentId &&
  a.generation === b.generation &&
  a.dispatcherEpoch === b.dispatcherEpoch;
