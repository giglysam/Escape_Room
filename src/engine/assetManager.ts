import { loadImage, removeBackground, trimTransparent } from "./imageUtils";
import type { GamePlan, RoomObject } from "../shared/plan";

export interface RenderableAsset {
  /** The drawable: HTMLImageElement (background) or HTMLCanvasElement (cutout). */
  source: CanvasImageSource;
  /** Natural pixel size of the drawable. */
  width: number;
  height: number;
}

export interface AssetSet {
  backgrounds: Map<string, RenderableAsset>; // keyed by room id
  objects: Map<string, RenderableAsset>; // keyed by `${roomId}:${objectId}`
}

export interface ProgressEvent {
  message: string;
  level: "info" | "ok" | "err";
  done: number;
  total: number;
}

export type ProgressCallback = (e: ProgressEvent) => void;

const STORAGE_KEY = (k: string) => `aiescape:asset:${k}`;

function cacheGet(key: string): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY(key));
  } catch {
    return null;
  }
}
function cacheSet(key: string, value: string) {
  try {
    localStorage.setItem(STORAGE_KEY(key), value);
  } catch {
    // quota — ignore
  }
}

/**
 * Call our serverless /api/generate-image endpoint to fetch a base64 data URL.
 * Returns the dataUrl on success, throws on failure.
 *
 * `sessionId` is forwarded so the proxy uses a fresh upstream session/UA per
 * call. This dodges per-IP rate limits when we fire multiple gens in parallel.
 */
async function generateImage(
  prompt: string,
  generatorType: string,
  sessionId: string,
): Promise<string> {
  const r = await fetch("/api/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
    body: JSON.stringify({ prompt, generatorType, sessionId }),
  });
  if (!r.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await r.json());
    } catch {
      // ignore
    }
    throw new Error(`HTTP ${r.status} ${detail.slice(0, 200)}`);
  }
  const data = (await r.json()) as { ok?: boolean; dataUrl?: string; error?: string };
  if (!data.ok || !data.dataUrl) {
    throw new Error(data.error ?? "No image returned");
  }
  return data.dataUrl;
}

/**
 * Generate (or load from cache) a single image with retries.
 */
function newSessionId(): string {
  // Random per-call session id — the serverless proxy uses this to seed a
  // brand-new upstream session and rotate User-Agent / Accept-Language /
  // sec-ch-ua headers, so concurrent calls don't share a fingerprint.
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

async function getOrGenerate(
  cacheKey: string,
  prompt: string,
  generatorType: string,
  retries = 3,
): Promise<string> {
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      // Fresh session id every attempt → fresh fingerprint every retry.
      const dataUrl = await generateImage(prompt, generatorType, newSessionId());
      cacheSet(cacheKey, dataUrl);
      return dataUrl;
    } catch (e) {
      lastErr = e;
      // Jittered backoff, only on retry; first miss is immediate.
      const delay = 400 * Math.pow(2, i) + Math.floor(Math.random() * 250);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw lastErr ?? new Error("generation failed");
}

/** Tiny concurrency limiter: run up to `n` async jobs in parallel. */
async function pMap<T, R>(
  items: T[],
  n: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners: Promise<void>[] = [];
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  };
  const concurrency = Math.max(1, Math.min(n, items.length));
  for (let k = 0; k < concurrency; k++) runners.push(run());
  await Promise.all(runners);
  return results;
}

/**
 * Build a placeholder solid-colour canvas, used if generation hard-fails so
 * the game still runs.
 */
function placeholder(
  label: string,
  w: number,
  h: number,
  color: string,
): RenderableAsset {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "bold 16px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w / 2, h / 2);
  return { source: c, width: w, height: h };
}

/**
 * Load all assets for a plan, calling progress for each step.
 *
 * - Backgrounds: generated with generatorType "architecture", left as-is.
 * - Objects: generated with generatorType "architecture" (sharp product shots),
 *   then if `removeBackground` is true, run client-side chroma key + crop.
 */
/** Maximum simultaneous in-flight generation requests. Chosen to be small
 * enough to dodge per-IP throttling but large enough to massively shorten the
 * loading screen vs serial. */
const GEN_CONCURRENCY = 5;

export async function loadPlanAssets(
  plan: GamePlan,
  onProgress: ProgressCallback,
): Promise<AssetSet> {
  type Job =
    | { kind: "bg"; roomId: string; prompt: string }
    | { kind: "obj"; roomId: string; prompt: string; obj: RoomObject };

  const jobs: Job[] = [];
  for (const room of plan.rooms) {
    jobs.push({ kind: "bg", roomId: room.id, prompt: room.background_prompt });
    for (const obj of room.objects) {
      jobs.push({ kind: "obj", roomId: room.id, prompt: obj.prompt, obj });
    }
  }

  const total = jobs.length;
  let done = 0;
  const emit = (message: string, level: ProgressEvent["level"]) =>
    onProgress({ message, level, done, total });

  const set: AssetSet = {
    backgrounds: new Map(),
    objects: new Map(),
  };

  emit(`Starting ${total} parallel generations (×${GEN_CONCURRENCY} at a time)…`, "info");

  await pMap(jobs, GEN_CONCURRENCY, async (job) => {
    const label = job.kind === "bg" ? `bg/${job.roomId}` : `${job.roomId}/${job.obj.name}`;
    try {
      if (job.kind === "bg") {
        const cacheKey = `bg:${job.roomId}:${job.prompt}`;
        const dataUrl = await getOrGenerate(cacheKey, job.prompt, "architecture");
        const img = await loadImage(dataUrl);
        set.backgrounds.set(job.roomId, {
          source: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      } else {
        const obj = job.obj;
        const cacheKey = `obj:${job.roomId}:${obj.id}:${job.prompt}`;
        const dataUrl = await getOrGenerate(cacheKey, job.prompt, "architecture");
        const img = await loadImage(dataUrl);
        let drawable: CanvasImageSource = img;
        let dw = img.naturalWidth;
        let dh = img.naturalHeight;
        if (obj.removeBackground) {
          const cut = removeBackground(img, { tolerance: 50, maxSize: 512 });
          const trimmed = trimTransparent(cut);
          drawable = trimmed;
          dw = trimmed.width;
          dh = trimmed.height;
        }
        set.objects.set(`${job.roomId}:${obj.id}`, { source: drawable, width: dw, height: dh });
      }
      done++;
      emit(`✓ ${label}`, "ok");
    } catch (e) {
      done++;
      const msg = e instanceof Error ? e.message : String(e);
      emit(`! ${label} failed (${msg}). Using fallback.`, "err");
      if (job.kind === "bg") {
        set.backgrounds.set(
          job.roomId,
          placeholder(`(missing bg) ${job.roomId}`, 1024, 640, "#1a1a2c"),
        );
      } else {
        const obj = job.obj;
        set.objects.set(
          `${job.roomId}:${obj.id}`,
          placeholder(obj.name, obj.width, obj.height, "#2a2a40"),
        );
      }
    }
  });

  emit(`All assets ready (${done}/${total}).`, "ok");
  return set;
}
