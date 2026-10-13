import net from "node:net";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
// OS-owned loopback port is an exclusive local instance lock; crashes release it.
// Hash collisions conservatively refuse startup, never permit duplicate writers.
export async function lockInstance(dir: string) {
  const hash = createHash("sha256")
    .update(realpathSync(dir).toLowerCase())
    .digest();
  const port = 30000 + (hash.readUInt16BE(0) % 30000);
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("PROCESSOR_INSTANCE_LOCKED")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return () => server.close();
}
