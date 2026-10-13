export function errorCode(error: unknown, fallback: string): string {
  const cause = error as { code?: unknown; message?: unknown } | null;
  const system: Record<string, string> = {
    ENOENT: "FILE_NOT_FOUND",
    EACCES: "FILE_ACCESS_DENIED",
    EPERM: "FILE_ACCESS_DENIED",
    ENOSPC: "DISK_FULL",
  };
  if (typeof cause?.code === "string" && system[cause.code])
    return system[cause.code];
  for (const code of [cause?.code, cause?.message]) {
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code))
      return code;
  }
  return fallback;
}
