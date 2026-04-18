/**
 * Procedurally-rendered player sprite.
 *
 * Draws a small humanoid using canvas primitives — no asset generation required
 * and it always fits the room aesthetic regardless of theme.
 */

export interface PlayerState {
  x: number;
  y: number;
  width: number;
  height: number;
  facing: "left" | "right";
  walkPhase: number; // 0..1
  moving: boolean;
}

export function drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerState) {
  const { x, y, width: w, height: h, facing, walkPhase, moving } = p;
  ctx.save();
  ctx.translate(x + w / 2, y);
  if (facing === "left") ctx.scale(-1, 1);
  ctx.translate(-w / 2, 0);

  const phase = moving ? walkPhase : 0;
  const legSwing = Math.sin(phase * Math.PI * 2) * 6;
  const armSwing = Math.sin(phase * Math.PI * 2) * 8;

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 2, w * 0.35, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // legs
  ctx.fillStyle = "#1f2733";
  ctx.fillRect(w * 0.32, h * 0.65, w * 0.14, h * 0.32 + legSwing * 0.2);
  ctx.fillRect(w * 0.54, h * 0.65, w * 0.14, h * 0.32 - legSwing * 0.2);

  // shoes
  ctx.fillStyle = "#0d1116";
  ctx.fillRect(w * 0.3, h * 0.96, w * 0.18, 4);
  ctx.fillRect(w * 0.52, h * 0.96, w * 0.18, 4);

  // body / jacket
  const bodyGrad = ctx.createLinearGradient(0, h * 0.3, 0, h * 0.7);
  bodyGrad.addColorStop(0, "#7c5cff");
  bodyGrad.addColorStop(1, "#3a2f8c");
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(w * 0.28, h * 0.32, w * 0.44, h * 0.36);

  // collar
  ctx.fillStyle = "#16e1c5";
  ctx.fillRect(w * 0.36, h * 0.32, w * 0.28, 4);

  // arms
  ctx.fillStyle = "#3a2f8c";
  ctx.fillRect(w * 0.18, h * 0.34 + armSwing * 0.2, w * 0.12, h * 0.3);
  ctx.fillRect(w * 0.7, h * 0.34 - armSwing * 0.2, w * 0.12, h * 0.3);

  // head
  ctx.fillStyle = "#f1d3b3";
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.22, w * 0.18, 0, Math.PI * 2);
  ctx.fill();

  // hair
  ctx.fillStyle = "#1a1024";
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.18, w * 0.2, Math.PI, Math.PI * 2);
  ctx.fill();

  // eye (facing right by default)
  ctx.fillStyle = "#0a0a14";
  ctx.fillRect(w * 0.58, h * 0.21, 3, 3);

  ctx.restore();
}
