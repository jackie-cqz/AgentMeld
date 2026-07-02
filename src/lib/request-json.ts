export class ApiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => null) as
    | { error?: string | { message?: string }; message?: string }
    | null;

  if (!response.ok) {
    const nestedMessage =
      payload?.error && typeof payload.error === "object" ? payload.error.message : null;
    const message =
      nestedMessage ??
      (typeof payload?.error === "string" ? payload.error : null) ??
      payload?.message ??
      `请求失败（${response.status}）`;
    throw new ApiRequestError(message, response.status);
  }

  return payload as T;
}
