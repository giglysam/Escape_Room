import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleOptions, readJson, fetchWithRetry } from "./_utils.js";

const BASE = "https://simple-generator-five.vercel.app";

// A pool of plausible browser fingerprints. Each request picks one — combined
// with a fresh sessionId we send to upstream, this prevents the per-IP
// throttle from binding all our parallel calls to the same identity.
const UA_POOL: Array<{
  ua: string;
  lang: string;
  platform: string;
  chUa: string;
  mobile: string;
}> = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    lang: "en-US,en;q=0.9",
    platform: '"Windows"',
    chUa: '"Chromium";v="145", "Not_A Brand";v="24", "Google Chrome";v="145"',
    mobile: "?0",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    lang: "en-US,en;q=0.9,fr;q=0.7",
    platform: '"macOS"',
    chUa: '"Not(A:Brand";v="24", "Chromium";v="118"',
    mobile: "?0",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    lang: "en-GB,en;q=0.9",
    platform: '"Linux"',
    chUa: '"Chromium";v="142", "Not_A Brand";v="24", "Google Chrome";v="142"',
    mobile: "?0",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    lang: "en-US,en;q=0.5",
    platform: '"Windows"',
    chUa: "",
    mobile: "?0",
  },
  {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    lang: "en-US,en;q=0.9",
    platform: '"iOS"',
    chUa: "",
    mobile: "?1",
  },
];

function fingerprintHeaders(seed: string, generatorType: string): Record<string, string> {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  const fp = UA_POOL[Math.abs(h) % UA_POOL.length]!;
  const rid = `${seed}-${Math.random().toString(36).slice(2, 9)}`;
  const headers: Record<string, string> = {
    "User-Agent": fp.ua,
    Accept: "*/*",
    "Accept-Language": fp.lang,
    Referer: `${BASE}/?type=${encodeURIComponent(generatorType)}`,
    Origin: BASE,
    "Content-Type": "application/json",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "X-Request-Id": rid,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Cookie: `_session=${encodeURIComponent(seed)}; sid=${encodeURIComponent(rid)}`,
  };
  if (fp.chUa) {
    headers["sec-ch-ua"] = fp.chUa;
    headers["sec-ch-ua-mobile"] = fp.mobile;
    headers["sec-ch-ua-platform"] = fp.platform;
  }
  return headers;
}

interface ImageReq {
  prompt: string;
  generatorType?: string;
  /** Random per-call id from the client — drives header rotation + warm-up. */
  sessionId?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJson<ImageReq>(req);
    const prompt = (body.prompt ?? "").trim();
    if (!prompt) {
      res.status(400).json({ error: "Missing prompt" });
      return;
    }
    const generatorType = body.generatorType ?? "architecture";
    const sessionId =
      body.sessionId ??
      (req.headers["x-session-id"] as string | undefined) ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const HEADERS = fingerprintHeaders(sessionId, generatorType);

    // Per-session warm-up — fresh "browser" hits the page first
    try {
      await fetchWithRetry(`${BASE}/?type=${encodeURIComponent(generatorType)}`, {
        method: "GET",
        headers: HEADERS,
      });
    } catch {
      // ignore warm-up errors
    }

    const apiResp = await fetchWithRetry(
      `${BASE}/api/generate`,
      {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          positivePrompt: prompt,
          generatorType,
        }),
      },
      6,
      900,
    );

    if (!apiResp.ok) {
      const text = await apiResp.text();
      res.status(apiResp.status).json({ error: "Upstream error", detail: text.slice(0, 400) });
      return;
    }

    const data: Record<string, unknown> = await apiResp.json();
    const rawUrl =
      (data.imageUrl as string | undefined) ??
      (data.url as string | undefined) ??
      (data.image as string | undefined);

    if (!rawUrl) {
      res.status(502).json({ error: "No image URL returned", data });
      return;
    }

    const fullUrl = rawUrl.startsWith("http") ? rawUrl : new URL(rawUrl, BASE).toString();

    const imgResp = await fetchWithRetry(fullUrl, {
      method: "GET",
      headers: { ...HEADERS, Accept: "image/*,*/*;q=0.8" },
    });

    if (!imgResp.ok) {
      res.status(502).json({ error: "Image download failed", status: imgResp.status });
      return;
    }

    const buf = Buffer.from(await imgResp.arrayBuffer());
    const dataUrl = `data:${imgResp.headers.get("content-type") ?? "image/jpeg"};base64,${buf.toString("base64")}`;

    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
    res.status(200).json({
      ok: true,
      dataUrl,
      sourceUrl: fullUrl,
      prompt,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: "Generation failed", detail: msg });
  }
}
