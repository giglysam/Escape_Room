/**
 * Procedurally-drawn 4-facing walking character.
 *
 * No external assets — every facing (front / back / left / right) is
 * synthesised on a small offscreen canvas at boot. The engine then
 * blits the right facing each frame, with a 2-frame walk cycle.
 *
 * REM games don't actually animate a character but the user wants the
 * point-and-click feel where the cursor click triggers a walk-to before
 * the puzzle modal opens.
 */

export type Facing = "front" | "back" | "left" | "right";

const SPRITE_W = 64;
const SPRITE_H = 96;

interface Frames {
  // each facing has [walkA, walkB] keyframes
  front: [HTMLCanvasElement, HTMLCanvasElement];
  back: [HTMLCanvasElement, HTMLCanvasElement];
  left: [HTMLCanvasElement, HTMLCanvasElement];
  right: [HTMLCanvasElement, HTMLCanvasElement];
}

let cached: Frames | null = null;

/**
 * Returns the cached sprite frames, building them on first call.
 * The character's palette is fixed (fits the dark cinematic theme
 * across every world we generate).
 */
export function getCharacterFrames(): Frames {
  if (cached) return cached;
  cached = {
    front: [drawFront(0), drawFront(1)],
    back: [drawBack(0), drawBack(1)],
    left: [drawSide(0, false), drawSide(1, false)],
    right: [drawSide(0, true), drawSide(1, true)],
  };
  return cached;
}

function blank(): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = SPRITE_W;
  c.height = SPRITE_H;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  return { c, ctx };
}

const SKIN = "#e2b89a";
const HAIR = "#1a1024";
const SHIRT = "#7c5cff";
const SHIRT_DARK = "#3a2f8c";
const PANTS = "#1f2733";
const SHOES = "#0d1116";
const RIM = "rgba(255,240,210,0.25)";

function head(ctx: CanvasRenderingContext2D, cx: number, cy: number, hairFront: boolean) {
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(SPRITE_W / 2, SPRITE_H - 6, 18, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fill();
  // hair
  ctx.fillStyle = HAIR;
  ctx.beginPath();
  if (hairFront) {
    ctx.arc(cx, cy - 2, 13, Math.PI, Math.PI * 2);
  } else {
    // back of head: full hair cap
    ctx.arc(cx, cy + 2, 13, 0, Math.PI * 2);
  }
  ctx.fill();
}

function torso(ctx: CanvasRenderingContext2D) {
  const grd = ctx.createLinearGradient(0, 32, 0, 60);
  grd.addColorStop(0, SHIRT);
  grd.addColorStop(1, SHIRT_DARK);
  ctx.fillStyle = grd;
  ctx.fillRect(SPRITE_W / 2 - 14, 36, 28, 28);
}

function legs(ctx: CanvasRenderingContext2D, swing: number) {
  ctx.fillStyle = PANTS;
  // left leg
  ctx.fillRect(SPRITE_W / 2 - 11, 64 + swing, 8, 22);
  // right leg
  ctx.fillRect(SPRITE_W / 2 + 3, 64 - swing, 8, 22);
  // shoes
  ctx.fillStyle = SHOES;
  ctx.fillRect(SPRITE_W / 2 - 12, 84 + swing, 10, 4);
  ctx.fillRect(SPRITE_W / 2 + 2, 84 - swing, 10, 4);
}

function rimLight(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = RIM;
  ctx.fillRect(SPRITE_W / 2 - 14, 36, 3, 28);
}

function drawFront(frame: number): HTMLCanvasElement {
  const { c, ctx } = blank();
  const swing = frame === 0 ? 0 : 2;
  legs(ctx, swing);
  torso(ctx);
  rimLight(ctx);
  head(ctx, SPRITE_W / 2, 22, true);
  // eyes
  ctx.fillStyle = "#0a0a14";
  ctx.fillRect(SPRITE_W / 2 - 5, 22, 2, 2);
  ctx.fillRect(SPRITE_W / 2 + 3, 22, 2, 2);
  return c;
}

function drawBack(frame: number): HTMLCanvasElement {
  const { c, ctx } = blank();
  const swing = frame === 0 ? 0 : 2;
  legs(ctx, swing);
  torso(ctx);
  // collar / hood
  ctx.fillStyle = HAIR;
  ctx.fillRect(SPRITE_W / 2 - 10, 34, 20, 4);
  rimLight(ctx);
  head(ctx, SPRITE_W / 2, 22, false);
  return c;
}

function drawSide(frame: number, facingRight: boolean): HTMLCanvasElement {
  const { c, ctx } = blank();
  const swing = frame === 0 ? 0 : 3;
  if (!facingRight) {
    ctx.translate(SPRITE_W, 0);
    ctx.scale(-1, 1);
  }
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(SPRITE_W / 2, SPRITE_H - 6, 16, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  // back leg (further from camera)
  ctx.fillStyle = PANTS;
  ctx.fillRect(SPRITE_W / 2 - 5, 64 - swing, 8, 22);
  ctx.fillStyle = SHOES;
  ctx.fillRect(SPRITE_W / 2 - 6, 84 - swing, 10, 4);
  // torso
  const grd = ctx.createLinearGradient(0, 32, 0, 60);
  grd.addColorStop(0, SHIRT);
  grd.addColorStop(1, SHIRT_DARK);
  ctx.fillStyle = grd;
  ctx.fillRect(SPRITE_W / 2 - 8, 36, 18, 28);
  // arm swinging forward
  ctx.fillStyle = SHIRT_DARK;
  ctx.fillRect(SPRITE_W / 2 + 6, 38 + swing, 6, 22);
  // front leg
  ctx.fillStyle = PANTS;
  ctx.fillRect(SPRITE_W / 2 - 1, 64 + swing, 8, 22);
  ctx.fillStyle = SHOES;
  ctx.fillRect(SPRITE_W / 2 - 2, 84 + swing, 10, 4);
  // head
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(SPRITE_W / 2, 22, 12, 0, Math.PI * 2);
  ctx.fill();
  // hair
  ctx.fillStyle = HAIR;
  ctx.beginPath();
  ctx.arc(SPRITE_W / 2, 20, 13, Math.PI, Math.PI * 2);
  ctx.fill();
  // eye on the camera-facing side
  ctx.fillStyle = "#0a0a14";
  ctx.fillRect(SPRITE_W / 2 + 4, 22, 2, 2);
  return c;
}

export const CHARACTER_W = SPRITE_W;
export const CHARACTER_H = SPRITE_H;
