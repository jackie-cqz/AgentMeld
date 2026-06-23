export type Platform = "posix" | "windows";

export function currentPlatform(): Platform {
  return process.platform === "win32" ? "windows" : "posix";
}
