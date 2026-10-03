import type { AppState, Workspace } from "../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: string[],
  ) {
    super(message);
  }
}

let workspace: Workspace = "demo";
export const setApiWorkspace = (ws: Workspace) => {
  workspace = ws;
};

export const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export async function api<T = { state: AppState }>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-workspace": workspace,
        "x-timezone": browserTimezone(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("Can't reach the Nikki server. Is it still running?", 0, "offline");
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    throw new ApiError(json?.error ?? `Request failed (${res.status}).`, res.status, json?.code, json?.details);
  }
  return json as T;
}

export const newRequestId = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
