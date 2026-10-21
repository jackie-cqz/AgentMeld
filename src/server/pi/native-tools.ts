/**
 * Pi's native tool vocabulary (stays Pi-side, #25 P2).
 *
 * The platform bridge works in PLATFORM names (`fs_read`, `fs_write`, …). This
 * map and the result-text extraction below are the only Pi-specific knowledge:
 * the loopback bridge translates a Pi native call into the neutral
 * `HarnessNativeCall` the platform understands, and turns Pi's `{content:[…]}`
 * result back into plain text. The admission, approval, quota and evidence
 * semantics live in `src/server/harness/native-tools.ts`.
 */

export const PI_NATIVE_TO_PLATFORM: Record<string, string> = {
  read: "fs_read", write: "fs_write", edit: "fs_patch", bash: "bash",
  ls: "fs_list", grep: "fs_search", find: "fs_glob",
};

/** The Pi native names for the platform-native tools this invocation provisions. */
export function nativeToolNames(platformNames: readonly string[]): string[] {
  return Object.entries(PI_NATIVE_TO_PLATFORM).filter(([, mapped]) => platformNames.includes(mapped)).map(([native]) => native);
}

/** Pi's tool result shape → the plain text the platform records. */
export function nativeResultText(result: unknown): string {
  if (!result || typeof result !== "object") return typeof result === "string" ? result : "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n").slice(0, 100000);
}
