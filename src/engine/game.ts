import type { GamePlan, RoomObject, RoomPlan, ToolKind } from "../shared/plan";
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
  playUnlock,
  playWarning,
  startAmbient,
  stopAmbient,
} from "./audio";

export interface InteractionRequest {
  object: RoomObject;
  room: RoomPlan;
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
  onHover: (
    info: {
      label: string;
      kind: RoomObject["kind"];
      clientX: number;
      clientY: number;
    } | null,
  ) => void;
}

/** An inventory slot the engine owns. The UI renders these directly. */
export interface InventoryItem {
  itemId: string;
  displayName: string;
  emoji: string;
  toolKind?: ToolKind;
  /** For notes: title + body are shown when the player clicks the tile. */
  noteTitle?: string;
  noteBody?: string;
}

export interface GameState {
  inventory: Map<string, InventoryItem>;
  flags: Set<string>;
  currentRoomIndex: number;
  /** Which tool the player has currently "equipped" (clicked in inv). */
  equippedToolId: string | null;
  /** Switch on/off state, keyed by switch object id. */
  switchStates: Map<string, boolean>;
  /** Object ids the player has fully consumed (picked up / broken). */
  consumedObjectIds: Set<string>;
}

interface PlacedObject {
  obj: RoomObject;
  drawRect: { x: number; y: number; w: number; h: number };
  hitRect: { x: number; y: number; w: number; h: number };
  asset: RenderableAsset;
}

const W = PLAN_CANVAS.width;
const H = PLAN_CANVAS.height;

/**
 * Room Escape Maker-style scene engine.
 *
 * The view is a fixed 16:9 room with the character standing on the
 * floor band. Clicking any interactable prop:
 *   1. Turns the character to face it and walks to its x-position.
 *   2. On arrival, fires `onInteract` for the React UI to open the
 *      appropriate modal (note, code-lock, pedestal, info).
 *
 * Picked-up items are hidden from the scene forever. Breakables and
 * keyed locks hide their children until the lock is solved.
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

  // -------- character (4-facing walking sprite) --------
  private charX: number;
  private charY: number;
  private charTargetX: number | null = null;
  private pendingInteract: PlacedObject | null = null;
  private charFacing: Facing = "front";
  private charPhase = 0;
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
      inventory: new Map(),
      flags: new Set(),
      currentRoomIndex: 0,
      equippedToolId: null,
      switchStates: new Map(),
      consumedObjectIds: new Set(),
    };
    this.secondsLeft = Math.max(60, plan.timeLimitSec ?? 420);
    this.charX = W / 2 - CHARACTER_W / 2;
    this.charY = H - 30 - CHARACTER_H;
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

  getAssetFor(objectId: string): RenderableAsset | null {
    return this.assets.objects.get(`${this.currentRoom.id}:${objectId}`) ?? null;
  }

  hasFlag(id: string): boolean {
    return this.state.flags.has(id);
  }
  setFlag(id: string) {
    this.state.flags.add(id);
  }

  hasItem(itemId: string): boolean {
    return this.state.inventory.has(itemId);
  }
  equipItem(itemId: string | null) {
    this.state.equippedToolId = itemId;
  }
  getEquipped(): InventoryItem | null {
    if (!this.state.equippedToolId) return null;
    return this.state.inventory.get(this.state.equippedToolId) ?? null;
  }

  /** Consume an inventory item (removes the tile). */
  consumeItem(itemId: string) {
    this.state.inventory.delete(itemId);
    if (this.state.equippedToolId === itemId) this.state.equippedToolId = null;
  }

  /** Add an inventory item built from a RoomObject's item fields. */
  private collectInventoryFromObject(obj: RoomObject) {
    if (!obj.itemId) return;
    if (this.state.inventory.has(obj.itemId)) return;
    const slot: InventoryItem = {
      itemId: obj.itemId,
      displayName: obj.itemDisplayName ?? obj.itemId,
      emoji: obj.itemEmoji ?? "📦",
      toolKind: obj.toolKind,
      noteTitle: obj.noteTitle,
      noteBody: obj.noteBody,
    };
    this.state.inventory.set(obj.itemId, slot);
    playPickup();
  }

  /** Pick up a tool item: add to inv, remove from scene, set flag. */
  pickUpTool(obj: RoomObject): "picked" | "already" {
    if (obj.itemId && this.state.inventory.has(obj.itemId)) return "already";
    this.collectInventoryFromObject(obj);
    if (obj.gives) this.setFlag(obj.gives);
    this.state.consumedObjectIds.add(obj.id);
    this.reloadPlaced();
    return "picked";
  }

  /**
   * Read a note: add a re-readable copy to inventory and set its flag.
   * The note in the world stays visible (it's still lying there) so
   * the player can re-open it in situ too. That matches REM's feel.
   */
  readNote(obj: RoomObject) {
    this.collectInventoryFromObject(obj);
    if (obj.gives) this.setFlag(obj.gives);
  }

  /**
   * Attempt to break a `breakable` with the currently-equipped tool.
   * Returns the outcome; the UI is expected to show a matching toast.
   */
  tryBreak(obj: RoomObject): "broken" | "wrong_tool" | "no_tool" {
    if (obj.kind !== "breakable") return "wrong_tool";
    const tool = this.getEquipped();
    if (!tool) return "no_tool";
    if (!obj.needsToolKind || tool.toolKind !== obj.needsToolKind) return "wrong_tool";
    if (obj.gives) this.setFlag(obj.gives);
    this.state.consumedObjectIds.add(obj.id);
    playBigSuccess();
    this.reloadPlaced();
    return "broken";
  }

  toggleSwitch(obj: RoomObject): boolean {
    const cur = this.state.switchStates.get(obj.id) ?? !!obj.initialOn;
    const next = !cur;
    this.state.switchStates.set(obj.id, next);
    playClick();
    // A switch's `gives` fires whenever it reaches its `targetOn` state.
    if (obj.gives && next === !!obj.targetOn) {
      this.setFlag(obj.gives);
      this.reloadPlaced();
    }
    return next;
  }
  isSwitchOn(id: string): boolean {
    return this.state.switchStates.get(id) ?? false;
  }

  /**
   * Submit a code answer for a keypad / letter_lock. If correct, the
   * needed key (if any) is consumed, the `gives` flag is set, and the
   * door for this room is unlocked (if `gives` matches `door_..._unlocked`).
   */
  submitCode(obj: RoomObject, entered: string): "correct" | "wrong" | "needs_key" {
    if (!obj.codeAnswer) return "wrong";
    if (obj.needsKeyItemId && !this.hasItem(obj.needsKeyItemId)) return "needs_key";
    const ok = entered.toUpperCase() === obj.codeAnswer.toUpperCase();
    if (!ok) {
      playFail();
      return "wrong";
    }
    if (obj.needsKeyItemId) this.consumeItem(obj.needsKeyItemId);
    if (obj.gives) this.setFlag(obj.gives);
    if (obj.gives && obj.gives.startsWith("door_") && obj.gives.endsWith("_unlocked")) {
      playUnlock();
    } else {
      playBigSuccess();
    }
    this.reloadPlaced();
    return "correct";
  }

  unlockDoor() {
    const flag = `door_${this.currentRoom.id}_unlocked`;
    if (!this.hasFlag(flag)) {
      this.setFlag(flag);
      playUnlock();
    }
  }

  isDoorUnlocked(): boolean {
    return this.hasFlag(`door_${this.currentRoom.id}_unlocked`);
  }

  advanceRoom() {
    const idx = this.state.currentRoomIndex + 1;
    if (idx >= this.plan.rooms.length) {
      this.gameEnded = true;
      this.cb.onWin();
      return;
    }
    // Reset per-room inventory: in a REM-style game tools don't carry
    // across rooms. (Notes do, but we clear them here for simplicity;
    // future work could preserve a subset.)
    this.state.inventory.clear();
    this.state.equippedToolId = null;
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
    this.state.switchStates = new Map();
    this.state.consumedObjectIds = new Set();

    for (const obj of this.currentRoom.objects) {
      if (obj.kind === "switch") {
        this.state.switchStates.set(obj.id, !!obj.initialOn);
      }
    }
    this.reloadPlaced();
  }

  /** Rebuild `placed` based on current flags / consumed objects. */
  private reloadPlaced() {
    if (!this.currentRoom) return;
    this.placed = [];
    for (const obj of this.currentRoom.objects) {
      if (this.state.consumedObjectIds.has(obj.id)) continue;
      if (obj.hiddenUntilFlag && !this.hasFlag(obj.hiddenUntilFlag)) continue;
      const asset = this.assets.objects.get(`${this.currentRoom.id}:${obj.id}`);
      if (!asset) continue;

      const fit = fitContain(asset.width, asset.height, obj.width, obj.height);
      const drawRect = {
        x: obj.x + fit.dx,
        y: obj.y + fit.dy,
        w: fit.dw,
        h: fit.dh,
      };
      // Hitbox = authored plan rectangle (REM-style interaction zone), not the
      // letterboxed sprite rect — matches fixed 1280×720 placement precision.
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
        label: labelFor(next.obj, this.getEquipped()?.toolKind ?? null),
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

  private queueInteract(hit: PlacedObject) {
    const propCx = hit.drawRect.x + hit.drawRect.w / 2;
    const targetX = Math.max(20, Math.min(W - CHARACTER_W - 20, propCx - CHARACTER_W / 2));
    this.charTargetX = targetX;
    this.pendingInteract = hit;
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

    // Background
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

    // Ambient overlay
    ctx.fillStyle = `${this.currentRoom.ambient_color}33`;
    ctx.fillRect(0, 0, W, H);

    // Z-order: smaller (y+h) first. Character is drawn between
    // floor_back and floor_front bands by splitting the list.
    const sorted = [...this.placed].sort(
      (a, b) => a.drawRect.y + a.drawRect.h - (b.drawRect.y + b.drawRect.h),
    );

    const charBaseline = this.charY + CHARACTER_H;
    const back: PlacedObject[] = [];
    const front: PlacedObject[] = [];
    for (const p of sorted) {
      if (p.drawRect.y + p.drawRect.h <= charBaseline) back.push(p);
      else front.push(p);
    }

    this.drawPropList(back);
    this.drawCharacter();
    this.drawPropList(front);

    // Vignette
    const vg = ctx.createRadialGradient(
      W / 2,
      H / 2,
      Math.min(W, H) * 0.3,
      W / 2,
      H / 2,
      Math.max(W, H) * 0.7,
    );
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

  private drawPropList(list: PlacedObject[]) {
    const ctx = this.ctx;
    for (const p of list) {
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

      if (this.hoveredObject === p && p.obj.interactable) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = "rgba(124, 92, 255, 0.35)";
        ctx.beginPath();
        ctx.rect(p.drawRect.x, p.drawRect.y, p.drawRect.w, p.drawRect.h);
        ctx.clip();
        ctx.fillRect(p.drawRect.x, p.drawRect.y, p.drawRect.w, p.drawRect.h);
        ctx.restore();
      }
    }
  }

  private updateCharacter(dt: number) {
    if (this.charTargetX === null) return;
    const speed = 340;
    const dx = this.charTargetX - this.charX;
    const adx = Math.abs(dx);
    if (adx <= 4) {
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
    this.charPhase += dt * 6;
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

    if (obj.kind === "switch") {
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
      ctx.restore();
    } else if (
      obj.kind === "tool_item" ||
      obj.kind === "clue_note"
    ) {
      // Soft pulsing glow to draw the eye to pickupables
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
    } else if (obj.kind === "breakable") {
      // Subtle yellow pulse if we're carrying the right tool
      const tool = this.getEquipped();
      const correct = tool && obj.needsToolKind && tool.toolKind === obj.needsToolKind;
      if (correct) {
        ctx.save();
        const t = (performance.now() / 400) % (Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 184, 77, ${0.55 + Math.sin(t) * 0.25})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
        ctx.restore();
      }
    } else if (obj.kind === "keypad" || obj.kind === "letter_lock") {
      ctx.save();
      const label = obj.kind === "keypad" ? "KEYPAD" : "LETTERS";
      const chipW = Math.max(60, r.w * 0.9);
      const chipH = 16;
      const chipX = r.x + (r.w - chipW) / 2;
      const chipY = r.y - chipH - 2;
      ctx.fillStyle = "rgba(7,7,13,0.95)";
      this.roundRect(chipX, chipY, chipW, chipH, 4);
      ctx.fill();
      ctx.fillStyle = "#16e1c5";
      ctx.font = "bold 10px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, chipX + chipW / 2, chipY + chipH / 2 + 1);
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

/**
 * Tooltip label for an object. If the correct tool is equipped on a
 * breakable, the label previews the intended action ("Smash",
 * "Unscrew"). That mirrors REM's inline verb labels.
 */
function labelFor(obj: RoomObject, equippedTool: ToolKind | null): string {
  switch (obj.kind) {
    case "door":
      return "Door";
    case "exit":
      return "Exit door";
    case "switch":
      return "Wall switch";
    case "clue_note":
      return "Read note";
    case "tool_item":
      return `Pick up ${obj.itemDisplayName ?? "item"}`;
    case "breakable": {
      if (obj.needsToolKind && equippedTool === obj.needsToolKind) {
        return obj.needsToolKind === "hammer"
          ? "Smash glass"
          : obj.needsToolKind === "screwdriver"
            ? "Unscrew grate"
            : obj.needsToolKind === "knife"
              ? "Cut seal"
              : obj.needsToolKind === "crowbar"
                ? "Pry open"
                : "Use tool";
      }
      return "Inspect";
    }
    case "keyed_lock":
      return "Open lock";
    case "keypad":
      return "Keypad";
    case "letter_lock":
      return "Letter lock";
    case "pedestal":
      return "Pedestal";
    case "sequence_clue":
      return "Wall mural";
    case "sequence_button":
      return `Button ${obj.symbol ?? ""}`.trim();
    case "switch_clue":
      return "Diagram";
    case "decoration":
      return "Inspect";
    default:
      return obj.name;
  }
}
