import type { GamePlan, RoomObject, RoomPlan } from "../shared/plan";
import { PLAN_CANVAS } from "../shared/plan";
import type { AssetSet, RenderableAsset } from "./assetManager";
import { fitContain } from "./imageUtils";
import {
  CHARACTER_H,
  CHARACTER_W,
  getCharacterFrames,
  type Facing,
} from "./character";
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
  /**
   * The placed sprite that was clicked — useful when the UI wants to
   * "zoom in" on the prop image before opening a puzzle.
   */
  asset: RenderableAsset;
  drawRect: { x: number; y: number; w: number; h: number };
}

export interface GameCallbacks {
  onInteract: (req: InteractionRequest) => void;
  onToast: (text: string) => void;
  onRoomChange: (room: RoomPlan) => void;
  onWin: () => void;
  onLose: () => void;
  onTimeTick: (secondsLeft: number) => void;
  /**
   * Fires whenever the prop under the cursor changes. `null` means the
   * cursor isn't over any interactable. `clientX`/`clientY` are the raw
   * page-space coords of the pointer so the React tooltip can follow.
   */
  onHover: (
    info: {
      label: string;
      kind: RoomObject["kind"];
      clientX: number;
      clientY: number;
    } | null,
  ) => void;
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
  /** Hitbox for clicks (uses the planned rect for stability). */
  hitRect: { x: number; y: number; w: number; h: number };
  asset: RenderableAsset;
}

const W = PLAN_CANVAS.width;
const H = PLAN_CANVAS.height;

/**
 * CSScape-style escape-room engine.
 *
 * No walking, no player avatar. The view is a fixed first-person camera
 * looking at the room's back wall and floor. Every prop is a clickable
 * hotspot. Click → either toggle a switch / advance a sequence in place,
 * or open a "zoom-in" investigation modal handled by the UI.
 */
export class GameEngine {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private plan: GamePlan;
  private assets: AssetSet;
  private cb: GameCallbacks;
  private state: GameState;

  private placed: PlacedObject[] = [];
  private currentRoom!: RoomPlan;

  private rafId = 0;
  private running = false;

  private hoveredObject: PlacedObject | null = null;

  // ---------- character (4-facing walking sprite) ----------
  private charX: number;
  private charY: number;
  private charTargetX: number | null = null;
  /** Pending interaction to fire when the character arrives at its target. */
  private pendingInteract: PlacedObject | null = null;
  private charFacing: Facing = "front";
  private charPhase = 0; // walk-cycle accumulator
  private lastTickT = 0;

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
    this.secondsLeft = Math.max(60, plan.timeLimitSec ?? 420);
    // Character starts standing in the middle-front of the room.
    this.charX = W / 2 - CHARACTER_W / 2;
    this.charY = H - 30 - CHARACTER_H;
    // Pre-build sprite frames so the first draw has them ready.
    void getCharacterFrames();
    this.loadRoom(0);
  }

  // ---------------- Public API ----------------

  start() {
    if (this.running) return;
    this.running = true;
    this.lastSecondTick = performance.now();
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

  /** Returns the asset for an object id in the current room (for UI zoom views). */
  getAssetFor(objectId: string): RenderableAsset | null {
    return this.assets.objects.get(`${this.currentRoom.id}:${objectId}`) ?? null;
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

  collectItem(itemId: string) {
    if (this.state.inventory.has(itemId)) return;
    this.state.inventory.add(itemId);
    playPickup();
  }

  getPedestalSlots(pedestalId: string): Set<string> {
    return this.state.pedestalSlots.get(pedestalId) ?? new Set();
  }

  isDoorUnlocked(): boolean {
    return this.hasFlag(`door_${this.currentRoom.id}_unlocked`);
  }

  private checkSwitchPuzzle() {
    const switches = this.currentRoom.objects.filter((o) => o.kind === "switch");
    if (switches.length === 0) return;
    const allCorrect = switches.every((sw) => {
      const cur = this.state.switchStates.get(sw.id) ?? false;
      return cur === !!sw.targetOn;
    });
    if (allCorrect) this.unlockDoor();
  }

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

  addSeconds(s: number) {
    this.secondsLeft = Math.max(0, this.secondsLeft + s);
    this.cb.onTimeTick(this.secondsLeft);
  }

  // ---------------- Internals ----------------

  private loadRoom(idx: number) {
    this.state.currentRoomIndex = idx;
    this.currentRoom = this.plan.rooms[idx]!;
    this.placed = [];

    for (const obj of this.currentRoom.objects) {
      if (obj.kind === "switch" && !this.state.switchStates.has(obj.id)) {
        this.state.switchStates.set(obj.id, !!obj.initialOn);
      }
    }
    this.state.sequenceProgress.set(this.currentRoom.id, 0);

    for (const obj of this.currentRoom.objects) {
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
      // Hitbox follows the plan rect (w/h), not the aspect-fitted sprite —
      // matches Room Escape Maker–style "interaction zones" so clicks line up
      // with the authored 1280×720 placement even when the cutout is letterboxed.
      const hitRect = { x: obj.x, y: obj.y, w: obj.width, h: obj.height };

      this.placed.push({ obj, drawRect, hitRect, asset });
    }
  }

  // ---------- input ----------

  private bindInput() {
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("mouseleave", this.onMouseLeave);
    this.canvas.addEventListener("touchstart", this.onTouchStart, { passive: false });
  }
  private unbindInput() {
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("mouseleave", this.onMouseLeave);
    this.canvas.removeEventListener("touchstart", this.onTouchStart);
  }

  private onMouseLeave = () => {
    if (this.hoveredObject) {
      this.hoveredObject = null;
      this.cb.onHover(null);
    }
  };

  private getCanvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  }

  private onMouseMove = (e: MouseEvent) => {
    const p = this.getCanvasPoint(e.clientX, e.clientY);
    const next = this.findObjectAt(p.x, p.y);
    const prev = this.hoveredObject;
    this.hoveredObject = next;
    this.canvas.style.cursor = next?.obj.interactable ? "pointer" : "default";

    if (next?.obj.interactable) {
      this.cb.onHover({
        label: labelFor(next.obj),
        kind: next.obj.kind,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    } else if (prev?.obj.interactable) {
      this.cb.onHover(null);
    }
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const p = this.getCanvasPoint(e.clientX, e.clientY);
    const hit = this.findObjectAt(p.x, p.y);
    if (hit && hit.obj.interactable) {
      this.queueInteract(hit);
    }
  };

  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]!;
    const p = this.getCanvasPoint(t.clientX, t.clientY);
    const hit = this.findObjectAt(p.x, p.y);
    if (hit && hit.obj.interactable) {
      e.preventDefault();
      this.queueInteract(hit);
    }
  };

  /**
   * REM-style click: the character walks horizontally to the prop's
   * x-position, then the actual interaction fires. Vertical movement
   * isn't needed — the character stays on the floor band.
   */
  private queueInteract(hit: PlacedObject) {
    const propCx = hit.drawRect.x + hit.drawRect.w / 2;
    // Standing target: a bit offset from the prop centre so character
    // doesn't overlap it, and clamped inside the floor band.
    const targetX = Math.max(20, Math.min(W - CHARACTER_W - 20, propCx - CHARACTER_W / 2));
    this.charTargetX = targetX;
    this.pendingInteract = hit;
    // Update facing immediately so the player sees the turn.
    this.charFacing = targetX < this.charX ? "left" : "right";
  }

  private findObjectAt(x: number, y: number): PlacedObject | null {
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

  // ---------- update / draw ----------

  private tick = (now: number) => {
    if (!this.running) return;
    const dt = this.lastTickT ? Math.min(0.06, (now - this.lastTickT) / 1000) : 0;
    this.lastTickT = now;
    this.updateCharacter(dt);

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

    this.draw();
    this.rafId = requestAnimationFrame(this.tick);
  };

  private draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    // Background — fill by aspect-cover
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

    // Subtle ambient overlay
    ctx.fillStyle = `${this.currentRoom.ambient_color}33`;
    ctx.fillRect(0, 0, W, H);

    // Sort objects so things further back (smaller y+h) draw first
    const sorted = [...this.placed].sort(
      (a, b) => a.drawRect.y + a.drawRect.h - (b.drawRect.y + b.drawRect.h),
    );

    for (const p of sorted) {
      // Soft contact shadow on the floor for floor-standing props
      const yCenter = p.drawRect.y + p.drawRect.h * 0.5;
      const onFloor = yCenter > PLAN_CANVAS.floorTop;
      if (onFloor) {
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
      this.tintPropToScene(p);
      this.drawObjectOverlay(p);

      // Hover highlight — subtle outer glow instead of dashed border
      if (this.hoveredObject === p && p.obj.interactable) {
        ctx.save();
        ctx.shadowColor = "rgba(124, 92, 255, 0.95)";
        ctx.shadowBlur = 18;
        ctx.strokeStyle = "rgba(124, 92, 255, 0)";
        ctx.lineWidth = 1;
        ctx.strokeRect(p.drawRect.x, p.drawRect.y, p.drawRect.w, p.drawRect.h);
        // Re-draw the asset with a cyan tint to glow it
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = "rgba(124, 92, 255, 0.35)";
        ctx.beginPath();
        ctx.rect(p.drawRect.x, p.drawRect.y, p.drawRect.w, p.drawRect.h);
        ctx.clip();
        ctx.fillRect(p.drawRect.x, p.drawRect.y, p.drawRect.w, p.drawRect.h);
        ctx.restore();
      }
    }

    // Character — drawn after all props so it always reads on top
    this.drawCharacter();

    // Vignette
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // Climax red tint
    if (!this.gameEnded && this.secondsLeft <= 60) {
      const stress = 1 - this.secondsLeft / 60;
      const pulse = (Math.sin(performance.now() / 220) + 1) / 2;
      const alpha = Math.min(0.55, 0.12 + stress * 0.35 + pulse * stress * 0.25);
      ctx.fillStyle = `rgba(255, 32, 50, ${alpha})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /**
   * Walks the character toward `charTargetX` along the floor band. When
   * arrived (within 4 px), fires the queued interaction.
   */
  private updateCharacter(dt: number) {
    if (this.charTargetX === null) return;
    const speed = 320; // px/s
    const dx = this.charTargetX - this.charX;
    const adx = Math.abs(dx);
    if (adx <= 4) {
      // Arrived → fire the pending interaction.
      this.charX = this.charTargetX;
      this.charTargetX = null;
      this.charFacing = "front";
      const hit = this.pendingInteract;
      this.pendingInteract = null;
      if (hit) {
        this.cb.onInteract({
          object: hit.obj,
          room: this.currentRoom,
          asset: hit.asset,
          drawRect: hit.drawRect,
        });
      }
      return;
    }
    const step = Math.min(adx, speed * dt);
    this.charX += Math.sign(dx) * step;
    this.charFacing = dx < 0 ? "left" : "right";
    this.charPhase += dt * 6; // ~6 walk frames per second
  }

  private drawCharacter() {
    const ctx = this.ctx;
    const frames = getCharacterFrames();
    const moving = this.charTargetX !== null;
    const frameIdx = moving ? Math.floor(this.charPhase) % 2 : 0;
    const fr = frames[this.charFacing][frameIdx]!;
    ctx.drawImage(fr, Math.round(this.charX), Math.round(this.charY));
  }

  private tintPropToScene(p: PlacedObject) {
    const ctx = this.ctx;
    const { drawRect: r } = p;
    if (r.w <= 0 || r.h <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = `${this.currentRoom.ambient_color}40`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const grd = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
    grd.addColorStop(0, "rgba(255,240,210,0.18)");
    grd.addColorStop(0.5, "rgba(0,0,0,0)");
    grd.addColorStop(1, "rgba(0,0,0,0.22)");
    ctx.fillStyle = grd;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

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
      return "Door";
    case "exit":
      return "Exit door";
    case "item":
      return "Pick up";
    case "pedestal":
      return "Pedestal";
    case "sequence_clue":
      return "Wall mural";
    case "sequence_button":
      return `Button ${obj.symbol ?? ""}`.trim();
    case "switch":
      return `Switch ${obj.symbol ?? ""}`.trim();
    case "switch_clue":
      return "Diagram";
    case "decoration":
      return "Inspect";
    default:
      return obj.name;
  }
}
