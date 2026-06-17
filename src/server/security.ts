import type { Platform } from "@/server/platform";
import { currentPlatform } from "@/server/platform";

const POSIX_BANNED: RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\bsudo\b/,
  /\bchmod\s+\d{3,4}\s+\//,
  /:\(\)\{\s*:\|:&\s*\}/,
  /curl\s+[^|]*\|\s*(bash|sh)/,
  /wget\s+[^|]*\|\s*(bash|sh)/,
  /\beval\b/,
  /\bexec\b\s+/
];

const WINDOWS_BANNED: RegExp[] = [
  /\b(del|erase)\s+\/[fsq\s/]*[a-z]:\\?/i,
  /\brd\s+\/[sq\s/]*[a-z]:\\?/i,
  /\bRemove-Item\b[^|;]*-Recurse[^|;]*-Force/i,
  /\bRemove-Item\b[^|;]*-Force[^|;]*-Recurse/i,
  /\bri\b[^|;]*-Recurse[^|;]*-Force/i,
  /\brm\b[^|;]*-Recurse[^|;]*-Force/i,
  /\brm\b[^|;]*-Force[^|;]*-Recurse/i,
  /\brmdir\b[^|;]*-Recurse[^|;]*-Force/i,
  /\brmdir\b[^|;]*-Force[^|;]*-Recurse/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\breg\s+delete\b/i,
  /\bRemove-ItemProperty\b/i,
  /\btaskkill\b[^|;]*\/im\s*\*/i,
  /\bStop-Process\b[^|;]*-Force[^|;]*\*/i,
  /Invoke-Expression\s*\(\s*(Invoke-WebRequest|iwr|curl|wget)/i,
  /\biex\b\s*\(\s*(iwr|curl|wget|Invoke-WebRequest)/i,
  /Set-ExecutionPolicy\s+(Unrestricted|Bypass)/i,
  /\bbcdedit\b/i,
  /\bdiskpart\b/i,
  /\bcipher\s+\/w/i
];

export function getBannedPatterns(platform?: Platform): RegExp[] {
  const resolved = platform ?? currentPlatform();
  return resolved === "windows" ? WINDOWS_BANNED : POSIX_BANNED;
}

export function findBannedPattern(command: string, platform?: Platform): RegExp | null {
  for (const pattern of getBannedPatterns(platform)) {
    if (pattern.test(command)) return pattern;
  }
  return null;
}
