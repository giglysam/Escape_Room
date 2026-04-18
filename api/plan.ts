import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleOptions, readJson, fetchWithRetry } from "./_utils.js";
import { generateProceduralPlan, type GamePlan, type PlanReq } from "../src/shared/plan.js";

async function tryLLMPlan(req: PlanReq): Promise<GamePlan | null> {
  // Best-effort attempt to use the user-provided "grok3.wasmer.app" service
  // as an LLM for a freeform theme expansion. If anything fails or returns
  // unparseable JSON, we fall back to procedural generation.
  try {
    const r = await fetchWithRetry(
      "https://grok3.wasmer.app/api/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
          Referer: "https://grok3.wasmer.app/",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        },
        body: JSON.stringify({
          prompt: `Design a 3-room point-and-click escape room with theme "${req.theme}". Return strict JSON only.`,
          type: "text",
        }),
        signal: AbortSignal.timeout(8000),
      },
      1,
      400,
    );
    if (!r.ok) return null;
    const data = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) return null;
    const cand = (data["plan"] ?? data) as GamePlan;
    if (cand && Array.isArray(cand.rooms) && cand.rooms.length > 0) return cand;
    return null;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleOptions(req, res)) return;
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const body =
      req.method === "POST"
        ? await readJson<PlanReq>(req)
        : ((req.query as unknown) as PlanReq);

    let plan: GamePlan | null = null;
    if (body.theme && body.theme.length > 1) {
      plan = await tryLLMPlan(body);
    }
    if (!plan) plan = generateProceduralPlan(body);

    res.status(200).json({ ok: true, plan });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: "Plan failed", detail: msg });
  }
}
