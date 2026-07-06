// ---------------------------------------------------------------------------
// P3: Structured backend logger with error categories and sensitive-data masking
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_server"
  | "provider_invalid_response"
  | "tool_validation"
  | "tool_execution"
  | "approval_rejected"
  | "approval_interrupted"
  | "workspace_security"
  | "context_overflow"
  | "conductor_contract"
  | "run_aborted"
  | "run_interrupted";

// ── P4: Fine-grained tool failure classification ───────────────────────────
// Sub-categories of "tool_execution" for diagnostics and metrics.

export type ToolFailureCategory =
  | "json_parse_error"
  | "schema_validation_error"
  | "permission_denied"
  | "approval_required"
  | "workspace_path_error"
  | "command_failed"
  | "timeout"
  | "missing_evidence"
  | "model_stopped_early"
  | "unknown";

/** Classify a tool error into a granular failure category. */
export function classifyToolError(error: Error | string, toolName?: string): ToolFailureCategory {
  const msg = typeof error === "string" ? error : error.message;

  if (/JSON|parse|unexpected token|Unexpected end of JSON/i.test(msg)) return "json_parse_error";
  if (/schema|validation|invalid|ZodError/i.test(msg)) return "schema_validation_error";
  if (/permission|denied|EPERM|EACCES/i.test(msg)) return "permission_denied";
  if (/approval|approved|rejected|pending_approval/i.test(msg)) return "approval_required";
  if (/workspace|path|ENOENT|outside workspace/i.test(msg)) return "workspace_path_error";
  if (/command.*failed|exit code|non-zero/i.test(msg)) return "command_failed";
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return "timeout";
  if (/missing evidence|evidence.*not found/i.test(msg)) return "missing_evidence";
  if (/stopped early|model stopped|aborted|interrupted/i.test(msg)) return "model_stopped_early";
  return "unknown";
}

export interface LogContext {
  conversationId?: string;
  runId?: string;
  parentRunId?: string;
  agentId?: string;
  taskId?: string;
  attempt?: number;
  stage?: string;
}

export interface ErrorDetail {
  category: ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  providerStatus?: number;
  stage?: string;
  toolName?: string;
  cause?: string;
}

const SENSITIVE_KEYS = new Set([
  "api_key", "apikey", "apiKey",
  "authorization", "auth", "token",
  "secret", "password", "passwd",
  "cookie", "set-cookie",
  "access_key", "accesskey",
]);

function maskSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase().replace(/[-_]/g, "");
    if (SENSITIVE_KEYS.has(lower) || SENSITIVE_KEYS.has(key)) {
      result[key] = "***REDACTED***";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = maskSensitive(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function formatLog(level: string, event: string, ctx: LogContext, data?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const masked = data ? maskSensitive(data) : undefined;
  const entry: Record<string, unknown> = { ts: timestamp, level, event };
  if (ctx.conversationId) entry.conv = ctx.conversationId;
  if (ctx.runId) entry.run = ctx.runId;
  if (ctx.parentRunId) entry.parent = ctx.parentRunId;
  if (ctx.agentId) entry.agent = ctx.agentId;
  if (ctx.taskId) entry.task = ctx.taskId;
  if (ctx.attempt !== undefined) entry.attempt = ctx.attempt;
  if (ctx.stage) entry.stage = ctx.stage;
  if (masked) entry.data = masked;
  return JSON.stringify(entry);
}

export const logger = {
  info(event: string, ctx: LogContext, data?: Record<string, unknown>) {
    console.log(formatLog("INFO", event, ctx, data));
  },
  warn(event: string, ctx: LogContext, data?: Record<string, unknown>) {
    console.warn(formatLog("WARN", event, ctx, data));
  },
  error(event: string, ctx: LogContext, data?: Record<string, unknown>) {
    console.error(formatLog("ERROR", event, ctx, data));
  }
};

/** Classify a provider HTTP error into an ErrorCategory */
export function classifyProviderError(status: number, body?: string): { category: ErrorCategory; retryable: boolean } {
  if (status === 401 || status === 403) return { category: "provider_auth", retryable: false };
  if (status === 429) return { category: "provider_rate_limit", retryable: true };
  if (status >= 500) return { category: "provider_server", retryable: true };
  if (status === 408 || (body && body.includes("timeout"))) return { category: "provider_timeout", retryable: true };
  return { category: "provider_invalid_response", retryable: false };
}

/** Build a structured error detail for persistence and API */
export function buildErrorDetail(
  category: ErrorCategory,
  message: string,
  retryable: boolean,
  overrides?: Partial<ErrorDetail>
): ErrorDetail {
  return { category, code: category, message: message.slice(0, 500), retryable, ...overrides };
}
