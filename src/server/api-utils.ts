import { z } from "zod";

// ---------------------------------------------------------------------------
// Unified API error / success response helpers
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: string;
  details?: unknown;
  code?: string;
}

export interface ApiSuccessBody<T = unknown> {
  data: T;
}

/**
 * Return a structured 400 error response.
 */
export function badRequest(message: string, details?: unknown): Response {
  return Response.json(
    { error: message, details: details ?? null } satisfies ApiErrorBody,
    { status: 400 }
  );
}

/**
 * Return a structured 404 error response.
 */
export function notFound(message = "Resource not found."): Response {
  return Response.json(
    { error: message } satisfies ApiErrorBody,
    { status: 404 }
  );
}

/**
 * Return a structured 409 error response.
 */
export function conflict(message: string): Response {
  return Response.json(
    { error: message } satisfies ApiErrorBody,
    { status: 409 }
  );
}

/**
 * Return a structured 500 error response.
 */
export function serverError(message = "Internal server error."): Response {
  return Response.json(
    { error: message } satisfies ApiErrorBody,
    { status: 500 }
  );
}

/**
 * Return a 201 created response.
 */
export function created<T>(data: T): Response {
  return Response.json({ data } satisfies ApiSuccessBody<T>, { status: 201 });
}

/**
 * Return a 200 ok response.
 */
export function ok<T>(data: T): Response {
  return Response.json({ data } satisfies ApiSuccessBody<T>);
}

/**
 * Return a 202 accepted response.
 */
export function accepted<T>(data: T): Response {
  return Response.json({ data } satisfies ApiSuccessBody<T>, { status: 202 });
}

/**
 * Return a 204 no content response.
 */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Zod validation helper for route handlers
// ---------------------------------------------------------------------------

/**
 * Parse request body with zod. Returns parsed data or a 400 Response.
 */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodSchema<T>
): Promise<T | Response> {
  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Validation failed.", parsed.error.flatten());
  }
  return parsed.data;
}

/**
 * Wrap a route handler's business logic, catching errors as 500.
 */
export async function handleApi<T>(
  fn: () => Promise<T>
): Promise<Response> {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return ok(result);
  } catch (error) {
    return serverError(error instanceof Error ? error.message : "Unexpected error.");
  }
}
