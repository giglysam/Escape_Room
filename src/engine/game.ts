import type { GamePlan, RoomObject, RoomPlan } from "../shared/plan";
import { PLAN_CANVAS } from "../shared/plan";
import type { AssetSet, RenderableAsset } from "./assetManager";
import { fitContain } from "./imageUtils";
import { drawPlayer, type PlayerState } from "./player";

export interface InteractionRequest {
  object: RoomObject;
  room: RoomPlan;
}

export interface GameCallbacks {
  onInteract: (req: InteractionRequest) => void;
  onToast: (text: string) => void;
  onRoomChange: (room: RoomPlan) => void;
  onWin: () => void;
}

export interface GameState {
  inventory: Set<string>;
  flags: Set<string>;
  /** Object ids whose riddle has been solved this run */
  solvedRiddles: Set<string>;
  currentRoomIndex: number;
}

interface PlacedObject {
  obj: RoomObject;
  /** On-screen render rect (may be aspect-corrected within the plan rect). */
  drawRect: { x: number; y: number; w: number; h: number };
  /** Hitbox for collision/interaction (uses planned rect for stability). */
  hitRect: { x: number; y: number; w: number; h: number };
  /** Solid box used for player movement collision (smaller, on the floor). */
  solidRect: { x: number; y: number; w: number; h: number };
  asset: RenderableAsset;
}

const W = PLAN_CANVAS.width;
const H = PLAN_CANVAS.height;
const PLAYER_W = 60;
const PLAYER_H = 110;
const PLAYER_SPEED = 220; // px / sec
const FLOOR_TOP = PLAN_CANVAS.floorTop;
const FLOOR_BOTTOM = H - 24;
const INTERACT_RADIUS = 70;

export class GameEngine {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private plan: GamePlan;
  private assets: AssetSet;
  private cb: GameCallbacks;
  private state: GameState;

  private placed: PlacedObject[] = [];
  private currentRoom!: RoomPlan;

  private player: PlayerState;
  private keys = new Set<string>();
  private lastT = 0;
  private rafId = 0;
  private running = false;

  private hoveredObject: PlacedObject | null = null;
  private interactPrompt: PlacedObject | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    plan: GamePlan,
    assets: AssetSet,
    cb: GameCallbacks,
  ) {
    this.canvas = canvas;
    const c = canvas.getContext("2d");
    if (!c) throw new Error("Canvas 2D context unavailable");
    this.ctx = c;
    this.plan = plan;
    this.assets = assets;
    this.cb = cb;
    this.state = {
      inventory: new Set(),
      flags: new Set(),
      solvedRiddles: new Set(),
      currentRoomIndex: 0,
    };
    this.player = {
      x: 80,
      y: H - PLAYER_H - 24,
      width: PLAYER_W,
      height: PLAYER_H,
      facing: "right",
      walkPhase: 0,
      moving: false,
    };
    this.loadRoom(0);
  }

  // ---------------- Public API ----------------

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    this.bindInput();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.unbindInput();
  }

  getState(): GameState {
    return this.state;
  }

  getCurrentRoom(): RoomPlan {
    return this.currentRoom;
  }

  /** Player picked something up / a flag was set / inventory changed. */
  giveItem(id: string) {
    this.state.inventory.add(id);
  }
  hasItem(id: string): boolean {
    return this.state.inventory.has(id);
  }
  setFlag(id: string) {
    this.state.flags.add(id);
  }
  hasFlag(id: string): boolean {
    return this.state.flags.has(id);
  }

  /** Mark riddle on a note solved → unlocks the related container in the same room. */
  solveRiddle(noteObjectId: string) {
    this.state.solvedRiddles.add(noteObjectId);
    const roomId = this.currentRoom.id;
    this.setFlag(`riddle_${roomId}_solved`);
  }

  /** Move to next room, or trigger win if at exit. */
  advanceRoom() {
    const idx = this.state.currentRoomIndex + 1;
    if (idx >= this.plan.rooms.length) {
      this.cb.onWin();
      return;
    }
    this.loadRoom(idx);
    this.cb.onRoomChange(this.currentRoom);
  }

  // ---------------- Internals ----------------

  private loadRoom(idx: number) {
    this.state.currentRoomIndex = idx;
    this.currentRoom = this.plan.rooms[idx]!;
    this.placed = [];

    for (const obj of this.currentRoom.objects) {
      const asset = this.assets.objects.get(`${this.currentRoom.id}:${obj.id}`);
      if (!asset) continue;

      const fit = fitContain(asset.width, asset.height, obj.width, obj.height);
      const drawRect = {
        x: obj.x + fit.dx,
        y: obj.y + fit.dy,
        w: fit.dw,
        h: fit.dh,
      };
      const hitRect = { x: drawRect.x, y: drawRect.y, w: drawRect.w, h: drawRect.h };

      // Solid rect = the bottom 40% of the drawn sprite, used as a floor obstacle.
      // Avoids the player getting stuck on tall thin sprites.
      const solidH = Math.max(20, Math.round(drawRect.h * 0.4));
      const solidRect = obj.collidable
        ? {
            x: drawRect.x + 6,
            y: drawRect.y + drawRect.h - solidH,
            w: Math.max(20, drawRect.w - 12),
            h: solidH,
          }
        : { x: 0, y: 0, w: 0, h: 0 };

      this.placed.push({ obj, drawRect, hitRect, solidRect, asset });
    }

    // Reset player to left side of the room (or right if coming back, but we
    // don't model that here).
    this.player.x = 80;
    this.player.y = H - PLAYER_H - 24;
    this.player.facing = "right";
  }

  // ---------- input ----------

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
  }
  private unbindInput() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Allow typing into modal inputs without intercepting
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    this.keys.add(e.key);
    if (e.key === " " || e.key === "Enter" || e.key === "e" || e.key === "E") {
      e.preventDefault();
      this.tryInteract();
    }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key);
  };

  private getCanvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  }

  private onMouseMove = (e: MouseEvent) => {
    const p = this.getCanvasPoint(e.clientX, e.clientY);
    this.hoveredObject = this.findObjectAt(p.x, p.y);
    this.canvas.style.cursor = this.hoveredObject?.obj.interactable ? "pointer" : "default";
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const p = this.getCanvasPoint(e.clientX, e.clientY);
    const obj = this.findObjectAt(p.x, p.y);
    if (obj && obj.obj.interactable) {
      // Walk-to-and-interact: just trigger immediately if close enough,
      // otherwise show a toast hint.
      const px = this.player.x + this.player.width / 2;
      const py = this.player.y + this.player.height / 2;
      const cx = obj.drawRect.x + obj.drawRect.w / 2;
      const cy = obj.drawRect.y + obj.drawRect.h / 2;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist <= INTERACT_RADIUS + 60) {
        this.cb.onInteract({ object: obj.obj, room: this.currentRoom });
      } else {
        // auto-walk toward it horizontally
        if (cx < px) this.player.facing = "left";
        else this.player.facing = "right";
        this.cb.onToast("Walk closer to interact.");
      }
    }
  };

  private findObjectAt(x: number, y: number): PlacedObject | null {
    // top-down z order: later in list is drawn on top — iterate reverse
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i]!;
      if (
        x >= p.hitRect.x &&
        x <= p.hitRect.x + p.hitRect.w &&
        y >= p.hitRect.y &&
        y <= p.hitRect.y + p.hitRect.h
      ) {
        return p;
      }
    }
    return null;
  }

  private tryInteract() {
    if (!this.interactPrompt) return;
    this.cb.onInteract({ object: this.interactPrompt.obj, room: this.currentRoom });
  }

  // ---------- update / draw ----------

  private tick = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.update(dt);
    this.draw();
    this.rafId = requestAnimationFrame(this.tick);
  };

  private update(dt: number) {
    let dx = 0;
    let dy = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("a") || this.keys.has("A")) dx -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("d") || this.keys.has("D")) dx += 1;
    if (this.keys.has("ArrowUp") || this.keys.has("w") || this.keys.has("W")) dy -= 1;
    if (this.keys.has("ArrowDown") || this.keys.has("s") || this.keys.has("S")) dy += 1;

    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }

    const moving = dx !== 0 || dy !== 0;
    this.player.moving = moving;
    if (moving) {
      this.player.walkPhase = (this.player.walkPhase + dt * 2) % 1;
      if (dx < 0) this.player.facing = "left";
      else if (dx > 0) this.player.facing = "right";
    }

    const newX = this.player.x + dx * PLAYER_SPEED * dt;
    const newY = this.player.y + dy * PLAYER_SPEED * dt;

    // try X then Y so we slide along walls
    if (!this.collides(newX, this.player.y)) this.player.x = newX;
    if (!this.collides(this.player.x, newY)) this.player.y = newY;

    // clamp to floor band
    if (this.player.y + this.player.height > FLOOR_BOTTOM)
      this.player.y = FLOOR_BOTTOM - this.player.height;
    if (this.player.y + this.player.height < FLOOR_TOP + 10)
      this.player.y = FLOOR_TOP + 10 - this.player.height;
    if (this.player.x < 0) this.player.x = 0;
    if (this.player.x + this.player.width > W) this.player.x = W - this.player.width;

    // determine interact prompt: nearest interactable object within radius
    let bestDist = INTERACT_RADIUS + 30;
    let best: PlacedObject | null = null;
    const px = this.player.x + this.player.width / 2;
    const py = this.player.y + this.player.height / 2;
    for (const p of this.placed) {
      if (!p.obj.interactable) continue;
      const cx = p.drawRect.x + p.drawRect.w / 2;
      const cy = p.drawRect.y + p.drawRect.h / 2;
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    this.interactPrompt = best;
  }

  private collides(x: number, y: number): boolean {
    // collision uses just the player feet box (lower 40%)
    const feetH = Math.round(this.player.height * 0.4);
    const fx = x + 8;
    const fy = y + this.player.height - feetH;
    const fw = this.player.width - 16;
    const fh = feetH;

    for (const p of this.placed) {
      const r = p.solidRect;
      if (r.w === 0) continue;
      if (
        fx < r.x + r.w &&
        fx + fw > r.x &&
        fy < r.y + r.h &&
        fy + fh > r.y
      ) {
        return true;
      }
    }
    return false;
  }

  private draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    // background — fill by aspect-cover
    const bg = this.assets.backgrounds.get(this.currentRoom.id);
    if (bg) {
      const scale = Math.max(W / bg.width, H / bg.height);
      const dw = bg.width * scale;
      const dh = bg.height * scale;
      const dx = (W - dw) / 2;
      const dy = (H - dh) / 2;
      ctx.drawImage(bg.source, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = this.currentRoom.ambient_color;
      ctx.fillRect(0, 0, W, H);
    }

    // ambient overlay
    ctx.fillStyle = `${this.currentRoom.ambient_color}55`;
    ctx.fillRect(0, 0, W, H);

    // gradient floor-fade
    const grad = ctx.createLinearGradient(0, FLOOR_TOP - 80, 0, H);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, FLOOR_TOP - 80, W, H - (FLOOR_TOP - 80));

    // sort objects so things further back (smaller y+h) draw first
    const sorted = [...this.placed].sort(
      (a, b) => a.drawRect.y + a.drawRect.h - (b.drawRect.y + b.drawRect.h),
    );

    // Draw objects, with player interleaved by depth.
    let playerDrawn = false;
    const playerBase = this.player.y + this.player.height;
    for (const p of sorted) {
      const base = p.drawRect.y + p.drawRect.h;
      if (!playerDrawn && playerBase < base) {
        drawPlayer(ctx, this.player);
        playerDrawn = true;
      }
      // soft shadow under object on the floor
      if (p.obj.collidable) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        const shY = p.drawRect.y + p.drawRect.h - 4;
        ctx.beginPath();
        ctx.ellipse(
          p.drawRect.x + p.drawRect.w / 2,
          shY,
          p.drawRect.w * 0.4,
          6,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.drawImage(p.asset.source, p.drawRect.x, p.drawRect.y, p.drawRect.w, p.drawRect.h);

      // hover highlight
      if (this.hoveredObject === p && p.obj.interactable) {
        ctx.save();
        ctx.strokeStyle = "rgba(124, 92, 255, 0.9)";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(p.drawRect.x - 2, p.drawRect.y - 2, p.drawRect.w + 4, p.drawRect.h + 4);
        ctx.restore();
      }
    }
    if (!playerDrawn) drawPlayer(ctx, this.player);

    // Interact prompt
    if (this.interactPrompt) {
      const p = this.interactPrompt;
      const cx = p.drawRect.x + p.drawRect.w / 2;
      const cy = p.drawRect.y - 14;
      const text = `[E] ${labelFor(p.obj)}`;
      ctx.font = "600 14px Inter, system-ui, sans-serif";
      const tw = ctx.measureText(text).width + 16;
      ctx.fillStyle = "rgba(7,7,13,0.9)";
      this.roundRect(cx - tw / 2, cy - 22, tw, 22, 6);
      ctx.fill();
      ctx.fillStyle = "#16e1c5";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, cx, cy - 11);
    }

    // Vignette
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function labelFor(obj: RoomObject): string {
  switch (obj.kind) {
    case "door":
      return "Open door";
    case "exit":
      return "Open exit";
    case "keypad":
      return "Use keypad";
    case "note":
      return "Read note";
    case "container":
      return "Open container";
    case "key":
      return "Take key";
    case "switch":
      return "Toggle switch";
    case "tool":
      return "Take tool";
    default:
      return "Inspect";
  }
}
