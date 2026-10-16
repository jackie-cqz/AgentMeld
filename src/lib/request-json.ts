export class ApiRequestError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => null) as
    | { error?: string | { message?: string }; message?: string; code?: string }
    | null;

  if (!response.ok) {
    const nestedMessage =
      payload?.error && typeof payload.error === "object" ? payload.error.message : null;
    const message =
      nestedMessage ??
      (typeof payload?.error === "string" ? payload.error : null) ??
      payload?.message ??
      `请求失败（${response.status}）`;
    throw new ApiRequestError(message, response.status, payload?.code);
  }

  return payload as T;
}
