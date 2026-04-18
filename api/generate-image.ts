import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleOptions, readJson, fetchWithRetry } from "./_utils.js";

const BASE = "https://simple-generator-five.vercel.app";
const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
  Referer: `${BASE}/?type=architecture`,
  Origin: BASE,
  "Content-Type": "application/json",
};

interface ImageReq {
  prompt: string;
  generatorType?: string;
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

    // Warm-up
    try {
      await fetchWithRetry(`${BASE}/?type=${encodeURIComponent(generatorType)}`, {
        method: "GET",
        headers: HEADERS,
      });
    } catch {
      // ignore warm-up errors
    }

    const apiResp = await fetchWithRetry(`${BASE}/api/generate`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        positivePrompt: prompt,
        generatorType,
      }),
    });

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
      headers: HEADERS,
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
