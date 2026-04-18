import type { GamePlan, RoomObject, RoomPlan } from "../shared/plan";
import { PLAN_CANVAS } from "../shared/plan";
import type { AssetSet, RenderableAsset } from "./assetManager";
import { fitContain } from "./imageUtils";
import { drawPlayer, type PlayerState } from "./player";
import {
  playBigSuccess,
  playClick,
  playFail,
  playLose,
  playPickup,
  playSuccess,
  playUnlock,
  playWarning,
  startAmbient,
  stopAmbient,
} from "./audio";

export interface InteractionRequest {
  object: RoomObject;
  room: RoomPlan;
}

export interface GameCallbacks {
  onInteract: (req: InteractionRequest) => void;
  onToast: (text: string) => void;
  onRoomChange: (room: RoomPlan) => void;
  onWin: () => void;
  onLose: () => void;
  onTimeTick: (secondsLeft: number) => void;
}

export interface GameState {
  inventory: Set<string>;
  flags: Set<string>;
  currentRoomIndex: number;
  /** Switch on/off state, keyed by switch object id. */
  switchStates: Map<string, boolean>;
  /** Per-room sequence progress (which symbol-index they are pressing next). */
  sequenceProgress: Map<string, number>;
  /** Items currently placed on a given pedestal: pedestalId -> Set<itemId>. */
  pedestalSlots: Map<string, Set<string>>;
  /** Items the player has used / consumed (e.g. dropped onto a pedestal) — hidden from world. */
  consumedItems: Set<string>;
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

  private secondsLeft: number;
  private lastSecondTick = 0;
  private warned60 = false;
  private warned30 = false;
  private warned10 = false;
  private gameEnded = false;

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
      currentRoomIndex: 0,
      switchStates: new Map(),
      sequenceProgress: new Map(),
      pedestalSlots: new Map(),
      consumedItems: new Set(),
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
    this.secondsLeft = Math.max(60, plan.timeLimitSec ?? 420);
    this.loadRoom(0);
  }

  // ---------------- Public API ----------------

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    this.lastSecondTick = this.lastT;
    this.bindInput();
    startAmbient({ intensity: 0.6 });
    this.cb.onTimeTick(this.secondsLeft);
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.unbindInput();
    stopAmbient();
  }

  getSecondsLeft(): number {
    return this.secondsLeft;
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

  /** Mark this room's door as unlocked (used after a puzzle is fully solved). */
  unlockDoor() {
    if (!this.hasFlag(`door_${this.currentRoom.id}_unlocked`)) {
      this.setFlag(`door_${this.currentRoom.id}_unlocked`);
      playUnlock();
    }
  }

  /** Toggle a switch by id and return new state. */
  toggleSwitch(switchId: string): boolean {
    const cur = this.state.switchStates.get(switchId) ?? false;
    const next = !cur;
    this.state.switchStates.set(switchId, next);
    playClick();
    this.checkSwitchPuzzle();
    return next;
  }

  isSwitchOn(switchId: string): boolean {
    return this.state.switchStates.get(switchId) ?? false;
  }

  /** Push a sequence button. Returns 'correct' | 'wrong' | 'complete'. */
  pressSequenceButton(buttonObj: RoomObject): "correct" | "wrong" | "complete" {
    const roomId = this.currentRoom.id;
    const expectedIdx = this.state.sequenceProgress.get(roomId) ?? 0;
    if (buttonObj.symbolIndex === expectedIdx) {
      const next = expectedIdx + 1;
      const total = this.currentRoom.objects.filter((o) => o.kind === "sequence_button").length;
      if (next >= total) {
        this.state.sequenceProgress.set(roomId, next);
        playBigSuccess();
        this.unlockDoor();
        return "complete";
      }
      this.state.sequenceProgress.set(roomId, next);
      playSuccess();
      return "correct";
    }
    this.state.sequenceProgress.set(roomId, 0);
    playFail();
    return "wrong";
  }

  getSequenceProgress(): number {
    return this.state.sequenceProgress.get(this.currentRoom.id) ?? 0;
  }

  /** Place an item from inventory onto a pedestal. Returns true if accepted. */
  depositOnPedestal(pedestal: RoomObject, itemId: string): "accepted" | "rejected" | "complete" {
    if (!pedestal.acceptsItems?.includes(itemId)) {
      playFail();
      return "rejected";
    }
    if (!this.hasItem(itemId)) return "rejected";
    const slot = this.state.pedestalSlots.get(pedestal.id) ?? new Set();
    if (slot.has(itemId)) return "rejected";
    slot.add(itemId);
    this.state.pedestalSlots.set(pedestal.id, slot);
    this.state.inventory.delete(itemId);
    this.state.consumedItems.add(itemId);
    if (slot.size >= pedestal.acceptsItems.length) {
      playBigSuccess();
      this.unlockDoor();
      return "complete";
    }
    playSuccess();
    return "accepted";
  }

  /** Player picked up a world item. */
  collectItem(itemId: string) {
    if (this.state.inventory.has(itemId)) return;
    this.state.inventory.add(itemId);
    playPickup();
  }

  getPedestalSlots(pedestalId: string): Set<string> {
    return this.state.pedestalSlots.get(pedestalId) ?? new Set();
  }

  /** Has the player won the current room's puzzle? */
  isDoorUnlocked(): boolean {
    return this.hasFlag(`door_${this.currentRoom.id}_unlocked`);
  }

  /** Check whether the switch combination matches the target pattern. */
  private checkSwitchPuzzle() {
    const switches = this.currentRoom.objects.filter((o) => o.kind === "switch");
    if (switches.length === 0) return;
    const allCorrect = switches.every((sw) => {
      const cur = this.state.switchStates.get(sw.id) ?? false;
      return cur === !!sw.targetOn;
    });
    if (allCorrect) this.unlockDoor();
  }

  /** Move to next room, or trigger win if at exit. */
  advanceRoom() {
    const idx = this.state.currentRoomIndex + 1;
    if (idx >= this.plan.rooms.length) {
      this.gameEnded = true;
      this.cb.onWin();
      return;
    }
    this.loadRoom(idx);
    this.cb.onRoomChange(this.currentRoom);
  }

  /** Add seconds to the timer (e.g. on bonus). */
  addSeconds(s: number) {
    this.secondsLeft = Math.max(0, this.secondsLeft + s);
    this.cb.onTimeTick(this.secondsLeft);
  }

  // ---------------- Internals ----------------

  private loadRoom(idx: number) {
    this.state.currentRoomIndex = idx;
    this.currentRoom = this.plan.rooms[idx]!;
    this.placed = [];

    // Seed switch initial states for this room (only once)
    for (const obj of this.currentRoom.objects) {
      if (obj.kind === "switch" && !this.state.switchStates.has(obj.id)) {
        this.state.switchStates.set(obj.id, !!obj.initialOn);
      }
    }
    // Reset sequence progress for the room when entering
    this.state.sequenceProgress.set(this.currentRoom.id, 0);

    for (const obj of this.currentRoom.objects) {
      // Hide already-consumed items (placed on a pedestal)
      if (obj.kind === "item" && this.state.consumedItems.has(obj.id)) continue;
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

    // Timer — count down once per real second
    if (!this.gameEnded && now - this.lastSecondTick >= 1000) {
      this.lastSecondTick = now;
      this.secondsLeft = Math.max(0, this.secondsLeft - 1);
      this.cb.onTimeTick(this.secondsLeft);
      if (this.secondsLeft === 60 && !this.warned60) {
        this.warned60 = true;
        playWarning();
        this.cb.onToast("60 seconds left.");
      }
      if (this.secondsLeft === 30 && !this.warned30) {
        this.warned30 = true;
        playWarning();
        this.cb.onToast("30 seconds left!");
      }
      if (this.secondsLeft === 10 && !this.warned10) {
        this.warned10 = true;
        playWarning();
      }
      if (this.secondsLeft <= 0) {
        this.gameEnded = true;
        playLose();
        this.cb.onLose();
      }
    }

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
      this.drawObjectOverlay(p);

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

    // Climax tint — when time is short, throw a pulsing red tint over the
    // whole scene. The blueprint's "Adrenaline finish": low seconds → louder
    // visual stress.
    if (!this.gameEnded && this.secondsLeft <= 60) {
      const stress = 1 - this.secondsLeft / 60; // 0 at 60s, 1 at 0s
      const pulse = (Math.sin(performance.now() / 220) + 1) / 2;
      const alpha = Math.min(0.55, 0.12 + stress * 0.35 + pulse * stress * 0.25);
      ctx.fillStyle = `rgba(255, 32, 50, ${alpha})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /**
   * Per-object on-canvas overlays — symbols on buttons, ON/OFF chip on switches,
   * progress bar on pedestals, "open" outline on door once unlocked, etc.
   */
  private drawObjectOverlay(p: PlacedObject) {
    const ctx = this.ctx;
    const { obj, drawRect: r } = p;

    if (obj.kind === "sequence_button" && obj.symbol) {
      ctx.save();
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(r.w, r.h) * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#16e1c5";
      ctx.font = `bold ${Math.round(Math.min(r.w, r.h) * 0.5)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(obj.symbol, cx, cy + 1);
      ctx.restore();
    } else if (obj.kind === "switch") {
      const on = this.state.switchStates.get(obj.id) ?? !!obj.initialOn;
      ctx.save();
      // ON/OFF chip on top
      const chipW = Math.max(34, r.w * 0.7);
      const chipH = 16;
      const chipX = r.x + (r.w - chipW) / 2;
      const chipY = r.y - chipH - 2;
      ctx.fillStyle = on ? "rgba(74, 222, 128, 0.95)" : "rgba(255, 93, 108, 0.95)";
      this.roundRect(chipX, chipY, chipW, chipH, 4);
      ctx.fill();
      ctx.fillStyle = "#0a0a14";
      ctx.font = "bold 11px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(on ? "ON" : "OFF", chipX + chipW / 2, chipY + chipH / 2 + 1);
      // small label inside the switch with its number
      if (obj.symbol) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h * 0.7;
        ctx.beginPath();
        ctx.arc(cx, cy, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 14px Inter, system-ui, sans-serif";
        ctx.fillText(obj.symbol, cx, cy + 1);
      }
      ctx.restore();
    } else if (obj.kind === "pedestal" && obj.acceptsItems) {
      const slot = this.state.pedestalSlots.get(obj.id) ?? new Set<string>();
      ctx.save();
      const total = obj.acceptsItems.length;
      const w = Math.max(80, r.w * 0.7);
      const x = r.x + (r.w - w) / 2;
      const y = r.y - 22;
      ctx.fillStyle = "rgba(7,7,13,0.9)";
      this.roundRect(x, y, w, 18, 4);
      ctx.fill();
      ctx.fillStyle = "#16e1c5";
      ctx.font = "bold 11px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${slot.size} / ${total}`, x + w / 2, y + 9);
      ctx.restore();
    } else if (obj.kind === "item") {
      ctx.save();
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const t = (performance.now() / 600) % (Math.PI * 2);
      const radius = Math.min(r.w, r.h) * 0.7 + Math.sin(t) * 4;
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grd.addColorStop(0, "rgba(22, 225, 197, 0.45)");
      grd.addColorStop(1, "rgba(22, 225, 197, 0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if ((obj.kind === "door" || obj.kind === "exit") && this.isDoorUnlocked()) {
      ctx.save();
      ctx.strokeStyle = "rgba(74, 222, 128, 0.95)";
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
      ctx.restore();
    }
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
    case "item":
      return "Pick up";
    case "pedestal":
      return "Place item";
    case "sequence_clue":
      return "Read mural";
    case "sequence_button":
      return `Press ${obj.symbol ?? ""}`.trim();
    case "switch":
      return "Toggle";
    case "switch_clue":
      return "Inspect clue";
    default:
      return "Inspect";
  }
}
