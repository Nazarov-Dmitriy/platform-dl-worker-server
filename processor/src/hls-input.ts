import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
// All references must resolve to declared, hash-checked local source parts.
export function validateHlsInput(dir: string, paths: string[]): string {
  const declared = new Set(paths);
  const playlists = paths.filter((p) => p.endsWith(".m3u8"));
  const referenced = new Set<string>();
  for (const playlist of playlists) {
    const raw = readFileSync(join(dir, playlist), "utf8").replace(
      /^\uFEFF/,
      "",
    );
    if (!raw.startsWith("#EXTM3U")) throw new Error("INVALID_HLS_INPUT");
    const refs: string[] = [];
    for (const line of raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)) {
      if (!line.startsWith("#")) refs.push(line);
      for (const match of line.matchAll(/\bURI="([^"]*)"/g))
        refs.push(match[1]);
      if (line.startsWith("#EXT-X-KEY:") && !line.includes("METHOD=NONE"))
        throw new Error("ENCRYPTED_HLS_UNSUPPORTED");
    }
    for (const ref of refs) {
      if (!ref || /[:\\?#%]/.test(ref) || ref.startsWith("/"))
        throw new Error("EXTERNAL_HLS_REFERENCE");
      const path = posix.normalize(posix.join(posix.dirname(playlist), ref));
      if (path.startsWith("../") || !declared.has(path))
        throw new Error("UNDECLARED_HLS_REFERENCE");
      if (path.endsWith(".m3u8")) referenced.add(path);
    }
  }
  const roots = playlists.filter((p) => !referenced.has(p));
  if (roots.length !== 1) throw new Error("AMBIGUOUS_HLS_INPUT");
  return join(dir, roots[0]);
}
