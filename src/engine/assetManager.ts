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
 */
async function generateImage(
  prompt: string,
  generatorType: string,
): Promise<string> {
  const r = await fetch("/api/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, generatorType }),
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
async function getOrGenerate(
  cacheKey: string,
  prompt: string,
  generatorType: string,
  retries = 2,
): Promise<string> {
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const dataUrl = await generateImage(prompt, generatorType);
      cacheSet(cacheKey, dataUrl);
      return dataUrl;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 600 * Math.pow(2, i)));
    }
  }
  throw lastErr ?? new Error("generation failed");
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
export async function loadPlanAssets(
  plan: GamePlan,
  onProgress: ProgressCallback,
): Promise<AssetSet> {
  const bgs: Array<[string, string]> = []; // [roomId, prompt]
  const objs: Array<[string, string, RoomObject]> = []; // [roomId, prompt, obj]

  for (const room of plan.rooms) {
    bgs.push([room.id, room.background_prompt]);
    for (const obj of room.objects) {
      objs.push([room.id, obj.prompt, obj]);
    }
  }

  const total = bgs.length + objs.length;
  let done = 0;
  const emit = (message: string, level: ProgressEvent["level"]) =>
    onProgress({ message, level, done, total });

  const set: AssetSet = {
    backgrounds: new Map(),
    objects: new Map(),
  };

  // ---- Backgrounds ----
  for (const [roomId, prompt] of bgs) {
    emit(`Generating background for ${roomId}…`, "info");
    try {
      const cacheKey = `bg:${roomId}:${prompt}`;
      const dataUrl = await getOrGenerate(cacheKey, prompt, "architecture");
      const img = await loadImage(dataUrl);
      set.backgrounds.set(roomId, {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
      done++;
      emit(`✓ Background ${roomId}`, "ok");
    } catch (e) {
      done++;
      const msg = e instanceof Error ? e.message : String(e);
      emit(`! Background ${roomId} failed (${msg}). Using fallback.`, "err");
      set.backgrounds.set(roomId, placeholder(`(missing bg) ${roomId}`, 1024, 640, "#1a1a2c"));
    }
  }

  // ---- Objects ----
  for (const [roomId, prompt, obj] of objs) {
    emit(`Generating ${roomId}/${obj.name}…`, "info");
    try {
      const cacheKey = `obj:${roomId}:${obj.id}:${prompt}`;
      const dataUrl = await getOrGenerate(cacheKey, prompt, "architecture");
      const img = await loadImage(dataUrl);
      let drawable: CanvasImageSource = img;
      let dw = img.naturalWidth;
      let dh = img.naturalHeight;
      if (obj.removeBackground) {
        const cut = removeBackground(img, { tolerance: 42, maxSize: 512 });
        const trimmed = trimTransparent(cut);
        drawable = trimmed;
        dw = trimmed.width;
        dh = trimmed.height;
      }
      set.objects.set(`${roomId}:${obj.id}`, { source: drawable, width: dw, height: dh });
      done++;
      emit(`✓ ${roomId}/${obj.name}`, "ok");
    } catch (e) {
      done++;
      const msg = e instanceof Error ? e.message : String(e);
      emit(`! ${roomId}/${obj.name} failed (${msg}). Using fallback.`, "err");
      set.objects.set(
        `${roomId}:${obj.id}`,
        placeholder(obj.name, obj.width, obj.height, "#2a2a40"),
      );
    }
  }

  emit(`All assets ready (${done}/${total}).`, "ok");
  return set;
}
