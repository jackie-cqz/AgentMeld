import fs from "node:fs";
import path from "node:path";

import { parseJudgeResult } from "../schemas/judge-result";
import type { JudgeResult } from "./judge-types";

export class JudgeCache {
  constructor(private readonly directory: string) {}

  get(cacheKey: string, allowedEvidenceRefs?: Set<string>): JudgeResult | null {
    const filePath = this.pathFor(cacheKey);
    if (!fs.existsSync(filePath)) return null;
    return parseJudgeResult(JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown, allowedEvidenceRefs);
  }

  set(cacheKey: string, result: JudgeResult): string {
    fs.mkdirSync(this.directory, { recursive: true });
    const filePath = this.pathFor(cacheKey);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
    return filePath;
  }

  private pathFor(packetHash: string): string {
    return path.join(this.directory, `${packetHash}.json`);
  }
}
