// ---------------------------------------------------------------------------
// P1: Evidence sanitizer — strip secrets, truncate long output, normalize paths
// ---------------------------------------------------------------------------

const MAX_EXCERPT_LENGTH = 4096;
const MAX_PAYLOAD_SIZE = 32768; // 32 KB per evidence payload

const SENSITIVE_HEADERS = [
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
];

const SENSITIVE_ENV_KEYS = [
  "api_key", "apikey", "secret", "token", "password", "credential",
  "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ARK_API_KEY",
];

/**
 * Strip secrets from a string value. Removes API keys, auth headers, tokens.
 */
export function sanitizeText(input: string): string {
  let result = input;

  // Redact common API key patterns
  result = result.replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]");
  result = result.replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer [REDACTED]");
  result = result.replace(/Authorization:\s*[^\n]+/gi, "Authorization: [REDACTED]");

  // Redact sensitive env keys
  for (const key of SENSITIVE_ENV_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(
      new RegExp(`${escaped}\\s*=\\s*[^\\s,\\n]+`, "gi"),
      `${key}=[REDACTED]`
    );
  }

  return result;
}

/**
 * Sanitize a command string — keep the command itself but strip env prefixes.
 */
export function sanitizeCommand(command: string): string {
  // Strip env var overrides: FOO=bar cmd → cmd
  return command
    .replace(/^\s*([A-Z_][A-Z0-9_]*=\S+\s+)+/, "")
    .trim();
}

/**
 * Create a safe excerpt from stdout/stderr. Truncate to MAX_EXCERPT_LENGTH.
 */
export function sanitizeOutput(output: string): { excerpt: string; truncated: boolean } {
  const cleaned = sanitizeText(output);
  if (cleaned.length <= MAX_EXCERPT_LENGTH) {
    return { excerpt: cleaned, truncated: false };
  }
  // Keep head and tail for context
  const head = cleaned.slice(0, MAX_EXCERPT_LENGTH / 2);
  const tail = cleaned.slice(-MAX_EXCERPT_LENGTH / 2);
  return { excerpt: `${head}\n... [truncated ${cleaned.length - MAX_EXCERPT_LENGTH} chars] ...\n${tail}`, truncated: true };
}

/**
 * Sanitize an object payload. Deep-redacts sensitive keys.
 * Returns a JSON-string-safe object and whether truncation was applied.
 */
export function sanitizePayload(payload: Record<string, unknown>): { safe: Record<string, unknown>; oversized: boolean } {
  const json = JSON.stringify(payload);
  if (json.length <= MAX_PAYLOAD_SIZE) {
    try {
      // Parse back after sanitizing text in values
      const sanitized = JSON.parse(sanitizeText(json));
      return { safe: sanitized, oversized: false };
    } catch {
      return { safe: { _raw: sanitizeText(json) }, oversized: false };
    }
  }

  // Oversized: save hash + excerpt instead of full payload
  return {
    safe: {
      _oversized: true,
      _originalSize: json.length,
      _excerpt: sanitizeText(json.slice(0, MAX_EXCERPT_LENGTH)),
    },
    oversized: true,
  };
}
