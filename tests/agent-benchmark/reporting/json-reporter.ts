import fs from "node:fs";
import path from "node:path";

export function writeJsonReport(filePath: string, value: unknown): string {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(temporaryPath, absolutePath);
  return absolutePath;
}
