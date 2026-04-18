/**
 * Image utilities for the escape room engine:
 *   - load Image from data URL
 *   - background removal (chroma-key on near-white)
 *   - aspect-correct sizing inside a target box
 */

export interface SizedImage {
  image: HTMLImageElement;
  width: number;
  height: number;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src.slice(0, 80)}…`));
    img.src = src;
  });
}

/**
 * Fit (width, height) into target box (boxW, boxH) preserving aspect ratio,
 * returning the largest size that fits and centered offset within the box.
 */
export function fitContain(
  width: number,
  height: number,
  boxW: number,
  boxH: number,
): { dx: number; dy: number; dw: number; dh: number } {
  if (width <= 0 || height <= 0) return { dx: 0, dy: 0, dw: boxW, dh: boxH };
  const scale = Math.min(boxW / width, boxH / height);
  const dw = Math.round(width * scale);
  const dh = Math.round(height * scale);
  const dx = Math.round((boxW - dw) / 2);
  const dy = Math.round((boxH - dh) / 2);
  return { dx, dy, dw, dh };
}

/**
 * Remove a near-white / near-uniform-corner background from an image and
 * return a new HTMLCanvasElement with transparency.
 *
 * Strategy:
 *   - sample 4 corners; if they are bright & similar, treat them as the bg color
 *   - flood-fill from each corner, marking visited pixels as transparent within
 *     a tolerance distance
 *   - feather edges by 1 px to avoid hard halos
 */
export function removeBackground(
  source: HTMLImageElement,
  options: { tolerance?: number; maxSize?: number } = {},
): HTMLCanvasElement {
  const tolerance = options.tolerance ?? 38;
  const maxSize = options.maxSize ?? 512;

  const naturalW = source.naturalWidth || source.width;
  const naturalH = source.naturalHeight || source.height;
  const scale = Math.min(1, maxSize / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return canvas;

  ctx.drawImage(source, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  const idx = (x: number, y: number) => (y * w + x) * 4;

  const corners: Array<[number, number]> = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];

  // Determine bg color from brightest, most similar corners
  const cornerColors = corners.map(([cx, cy]) => {
    const i = idx(cx, cy);
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  });

  const avg = [0, 0, 0];
  for (const c of cornerColors) {
    avg[0]! += c[0]!;
    avg[1]! += c[1]!;
    avg[2]! += c[2]!;
  }
  avg[0]! /= 4;
  avg[1]! /= 4;
  avg[2]! /= 4;

  const brightness = (avg[0]! + avg[1]! + avg[2]!) / 3;
  // If the average corner isn't bright, this image probably isn't on a white bg.
  // Skip removal to avoid destroying the asset; we still return a canvas so the
  // caller can keep using a uniform pipeline.
  if (brightness < 175) {
    return canvas;
  }

  const bgR = avg[0]!;
  const bgG = avg[1]!;
  const bgB = avg[2]!;

  // Flood fill from each corner using a stack-based scan
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const [cx, cy] of corners) {
    stack.push(cx, cy);
  }

  const tol2 = tolerance * tolerance;

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const flat = y * w + x;
    if (visited[flat]) continue;

    const i = flat * 4;
    const dr = data[i]! - bgR;
    const dg = data[i + 1]! - bgG;
    const db = data[i + 2]! - bgB;
    const dist = dr * dr + dg * dg + db * db;
    if (dist > tol2) continue;

    visited[flat] = 1;
    data[i + 3] = 0; // transparent

    stack.push(x + 1, y);
    stack.push(x - 1, y);
    stack.push(x, y + 1);
    stack.push(x, y - 1);
  }

  // Feather: any opaque pixel adjacent to a removed pixel gets alpha softening
  // proportional to its similarity to background.
  const featherTol2 = (tolerance * 1.6) * (tolerance * 1.6);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const flat = y * w + x;
      if (visited[flat]) continue;
      // check 4-neighbours
      if (
        visited[flat - 1] ||
        visited[flat + 1] ||
        visited[flat - w] ||
        visited[flat + w]
      ) {
        const i = flat * 4;
        const dr = data[i]! - bgR;
        const dg = data[i + 1]! - bgG;
        const db = data[i + 2]! - bgB;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < featherTol2) {
          const a = Math.min(255, Math.max(0, Math.round((dist / featherTol2) * 255)));
          if (a < data[i + 3]!) data[i + 3] = a;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Trim transparent borders from a canvas, returning a new tightly-cropped canvas
 * plus the natural width/height. Returns the original if it's already opaque
 * edge-to-edge.
 */
export function trimTransparent(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return canvas;
  const { data } = ctx.getImageData(0, 0, w, h);

  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3]!;
      if (a > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return canvas; // fully transparent — keep
  if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) return canvas;

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d")!.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}
