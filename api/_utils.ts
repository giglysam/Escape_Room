import type { VercelRequest, VercelResponse } from "@vercel/node";

export function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function handleOptions(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.status(204).end();
    return true;
  }
  setCors(res);
  return false;
}

export async function readJson<T = unknown>(req: VercelRequest): Promise<T> {
  if (req.body && typeof req.body === "object") return req.body as T;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body) as T;
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
  backoffMs = 800,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) {
        return r;
      }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, backoffMs * Math.pow(2, i)));
  }
  throw lastErr ?? new Error("fetch failed");
}
