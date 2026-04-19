import React, { useCallback, useEffect, useRef, useState } from "react";
import { generateProceduralPlan, PLAN_CANVAS, type GamePlan, type RoomObject } from "./shared/plan";
import { loadPlanAssets, type AssetSet, type ProgressEvent } from "./engine/assetManager";
import { GameEngine, type InteractionRequest } from "./engine/game";
import { isMuted, playWin, setMuted } from "./engine/audio";

type Phase = "menu" | "loading" | "briefing" | "playing" | "won" | "lost";

type ModalState =
  | { kind: "info"; object: RoomObject; message?: string }
  | { kind: "sequence_clue"; object: RoomObject }
  | { kind: "switch_clue"; object: RoomObject }
  | { kind: "pedestal"; object: RoomObject };

export default function App() {
  const [phase, setPhase] = useState<Phase>("menu");
  const [theme, setTheme] = useState("");
  const [seed, setSeed] = useState("");
  const [plan, setPlan] = useState<GamePlan | null>(null);
  const [assets, setAssets] = useState<AssetSet | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; log: ProgressEvent[] }>({
    done: 0,
    total: 0,
    log: [],
  });
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [inventoryRev, setInventoryRev] = useState(0);
  const [currentRoomId, setCurrentRoomId] = useState<string>("");
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [muted, setMutedState] = useState<boolean>(isMuted());
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  // ---------------- start a game ----------------
  const startGame = useCallback(
    async (opts: { theme?: string; seed?: number }) => {
      setPhase("loading");
      setProgress({ done: 0, total: 0, log: [{ message: "Planning your escape room…", level: "info", done: 0, total: 0 }] });

      let nextPlan: GamePlan | null = null;

      // Try the serverless planner first (it can call an upstream LLM); if it
      // fails, generate fully locally so the game still works offline / with
      // any backend hiccups.
      try {
        const r = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: opts.theme, seed: opts.seed, rooms: 3 }),
        });
        if (r.ok) {
          const data = (await r.json()) as { ok?: boolean; plan?: GamePlan };
          if (data.ok && data.plan) nextPlan = data.plan;
        }
      } catch {
        /* ignore */
      }

      if (!nextPlan) {
        nextPlan = generateProceduralPlan({ theme: opts.theme, seed: opts.seed });
        setProgress((p) => ({
          ...p,
          log: [...p.log, { message: "Using offline planner (server unavailable).", level: "info", done: 0, total: 0 }],
        }));
      }

      setPlan(nextPlan);

      // load assets
      try {
        const set = await loadPlanAssets(nextPlan, (e) => {
          setProgress((p) => {
            const log = p.log.slice(-200);
            log.push(e);
            return { done: e.done, total: e.total, log };
          });
        });
        setAssets(set);
        // After assets are ready, show the mission briefing — only when the
        // player accepts do we start the actual game (and the timer).
        setPhase("briefing");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setProgress((p) => ({
          ...p,
          log: [...p.log, { message: `Fatal: ${msg}`, level: "err", done: 0, total: 0 }],
        }));
      }
    },
    [],
  );

  // ---------------- engine boot ----------------
  useEffect(() => {
    if (phase !== "playing" || !plan || !assets || !canvasRef.current) return;

    const engine = new GameEngine(canvasRef.current, plan, assets, {
      onInteract: (req) => handleInteract(req),
      onToast: (t) => showToast(t),
      onRoomChange: (room) => {
        setCurrentRoomId(room.id);
        setInventoryRev((n) => n + 1);
        showToast(room.intro);
      },
      onWin: () => {
        playWin();
        setPhase("won");
      },
      onLose: () => {
        setPhase("lost");
      },
      onTimeTick: (s) => setSecondsLeft(s),
      onHover: (info) => {
        if (info) setHover({ label: info.label, x: info.clientX, y: info.clientY });
        else setHover(null);
      },
    });
    engineRef.current = engine;
    setCurrentRoomId(engine.getCurrentRoom().id);
    showToast(engine.getCurrentRoom().intro);
    engine.start();

    return () => {
      engine.stop();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, plan, assets]);

  // ---------------- interaction handler ----------------
  const handleInteract = useCallback(
    (req: InteractionRequest) => {
      const engine = engineRef.current;
      if (!engine) return;
      const obj = req.object;

      // Chained-room gating: every interactable can declare `requires`,
      // a flag that must be set before it can be used. If the flag is
      // missing, show a hint and bail.
      if (
        obj.requires &&
        obj.kind !== "door" &&
        obj.kind !== "exit" &&
        !engine.hasFlag(obj.requires) &&
        !engine.hasItem(obj.requires)
      ) {
        showToast("You can't use this yet — something else first.");
        return;
      }

      switch (obj.kind) {
        // ---------- A) COLLECT & COMBINE ----------
        case "item": {
          if (!obj.gives) return;
          if (!engine.hasItem(obj.gives) && !engine.hasFlag(obj.gives)) {
            engine.collectItem(obj.gives);
            engine.setFlag(obj.gives);
            setInventoryRev((n) => n + 1);
            showToast(`Picked up: ${prettyItemName(obj.gives)}.`);
          }
          return;
        }
        case "pedestal": {
          // Chained-room mode: if pedestal accepts a single flag-id and we
          // already have it, consume it inline; otherwise open the modal
          // for multi-item pedestals (legacy collect rooms).
          const accepts = obj.acceptsItems ?? [];
          if (accepts.length === 1 && obj.gives) {
            const need = accepts[0]!;
            if (engine.hasItem(need) || engine.hasFlag(need)) {
              // Consume the inventory item and set the give-flag.
              if (engine.hasItem(need)) {
                engine.getState().inventory.delete(need);
                engine.getState().consumedItems.add(need);
              }
              engine.setFlag(obj.gives);
              if (obj.gives.startsWith("door_")) engine.unlockDoor();
              setInventoryRev((n) => n + 1);
              setModal({
                kind: "info",
                object: obj,
                message: "It clicks into place. Something just changed in the room.",
              });
              return;
            }
            showToast("It needs something you don't have yet.");
            return;
          }
          setModal({ kind: "pedestal", object: obj });
          return;
        }

        // ---------- B) SYMBOL SEQUENCE ----------
        case "sequence_clue": {
          setModal({ kind: "sequence_clue", object: obj });
          return;
        }
        case "sequence_button": {
          const r = engine.pressSequenceButton(obj);
          if (r === "complete") {
            setModal({
              kind: "info",
              object: obj,
              message:
                "The sequence locks in. A heavy thunk echoes — the door is unlocked. Click it to open.",
            });
          } else if (r === "correct") {
            const progress = engine.getSequenceProgress();
            const total = req.room.objects.filter((o) => o.kind === "sequence_button").length;
            showToast(`Correct. ${progress}/${total}`);
          } else {
            showToast("Wrong order. The sequence resets.");
          }
          return;
        }

        // ---------- C) LOGIC SWITCHES ----------
        case "switch": {
          const next = engine.toggleSwitch(obj.id);
          setInventoryRev((n) => n + 1);
          showToast(`Switch ${obj.symbol ?? ""} → ${next ? "ON" : "OFF"}`);
          // Chained-room: if this switch's `gives` flag is part of the
          // chain and the switch is now in its target state, set the
          // flag so the next step unlocks.
          if (obj.gives && next === !!obj.targetOn && !engine.hasFlag(obj.gives)) {
            engine.setFlag(obj.gives);
            setTimeout(
              () => showToast("Something in the room just woke up."),
              250,
            );
          }
          if (engine.isDoorUnlocked()) {
            setTimeout(
              () =>
                showToast("You hear the door's lock disengage. Click the door to open."),
              350,
            );
          }
          return;
        }
        case "switch_clue": {
          setModal({ kind: "switch_clue", object: obj });
          return;
        }

        // ---------- DOOR / EXIT ----------
        case "door":
        case "exit": {
          if (!engine.isDoorUnlocked()) {
            showToast("Locked. Solve this room's puzzle first.");
            return;
          }
          if (obj.kind === "exit") {
            setModal({
              kind: "info",
              object: obj,
              message: "The exit door swings open. Freedom.",
            });
            setTimeout(() => engine.advanceRoom(), 0);
          } else {
            setModal({
              kind: "info",
              object: obj,
              message: "The door unlocks. You step through into the next room.",
            });
            setTimeout(() => engine.advanceRoom(), 0);
          }
          return;
        }

        default: {
          if (obj.description) {
            setModal({ kind: "info", object: obj, message: obj.description });
          } else {
            showToast("Nothing interesting.");
          }
        }
      }
    },
    [showToast],
  );

  // ---------------- render ----------------
  return (
    <div className="app">
      {phase === "menu" && (
        <MenuScreen
          theme={theme}
          setTheme={setTheme}
          seed={seed}
          setSeed={setSeed}
          onStart={() =>
            startGame({
              theme: theme.trim() || undefined,
              seed: seed.trim() ? Number.parseInt(seed.trim(), 10) || undefined : undefined,
            })
          }
        />
      )}

      {phase === "loading" && <LoadingScreen progress={progress} />}

      {phase === "briefing" && plan && (
        <BriefingScreen
          plan={plan}
          onBegin={() => setPhase("playing")}
          onCancel={() => {
            setPhase("menu");
            setPlan(null);
            setAssets(null);
          }}
        />
      )}

      {(phase === "playing" || phase === "won" || phase === "lost") && plan && assets && (
        <div className="game-wrap">
          <Hud
            plan={plan}
            currentRoomId={currentRoomId}
            secondsLeft={secondsLeft}
            muted={muted}
            onToggleMute={() => {
              const next = !muted;
              setMuted(next);
              setMutedState(next);
            }}
            onQuit={() => {
              engineRef.current?.stop();
              setPhase("menu");
              setPlan(null);
              setAssets(null);
              setModal(null);
              setToast(null);
            }}
          />
          <div className="game-stage">
            <div className="canvas-column">
              <div
                className="canvas-frame"
                style={
                  {
                    "--wall-color": plan.rooms.find((r) => r.id === currentRoomId)?.ambient_color ?? "#0a0a14",
                    "--floor-color": darkenHex(
                      plan.rooms.find((r) => r.id === currentRoomId)?.ambient_color ?? "#0a0a14",
                      0.55,
                    ),
                  } as React.CSSProperties
                }
              >
                <div className="canvas-bg-wall" />
                <div className="canvas-bg-floor" />
                <canvas
                  ref={canvasRef}
                  className="game-canvas"
                  width={PLAN_CANVAS.width}
                  height={PLAN_CANVAS.height}
                />
              </div>
              <GameNavBar
                roomNumber={plan.rooms.findIndex((r) => r.id === currentRoomId) + 1}
                totalRooms={plan.rooms.length}
              />
            </div>
            <InventorySidebar
              inventory={engineRef.current ? Array.from(engineRef.current.getState().inventory) : []}
              invRev={inventoryRev}
              onClick={(itemId) => {
                const desc = describeItem(itemId, plan);
                setModal({
                  kind: "info",
                  object: {
                    id: `inv_${itemId}`,
                    name: itemId,
                    prompt: "",
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                    collidable: false,
                    interactable: false,
                    removeBackground: false,
                    kind: "decoration",
                  } as RoomObject,
                  message: desc,
                });
              }}
            />
          </div>
          {hover && phase === "playing" && (
            <HoverTooltip label={hover.label} x={hover.x} y={hover.y} />
          )}
          {modal && (
            <ModalView
              modal={modal}
              inventory={
                engineRef.current ? Array.from(engineRef.current.getState().inventory) : []
              }
              onClose={() => setModal(null)}
              onDeposit={(pedestalObj, itemId) => {
                const engine = engineRef.current;
                if (!engine) return;
                const r = engine.depositOnPedestal(pedestalObj, itemId);
                setInventoryRev((n) => n + 1);
                if (r === "complete") {
                  setModal({
                    kind: "info",
                    object: pedestalObj,
                    message:
                      "All offerings accepted. The pedestal hums and the door's lock disengages.",
                  });
                } else if (r === "accepted") {
                  showToast("Accepted.");
                } else {
                  showToast("That doesn't fit here.");
                }
              }}
            />
          )}
          {toast && <div className="toast">{toast}</div>}
          {phase === "won" && (
            <div className="win-screen">
              <div className="card">
                <h1>You escaped.</h1>
                <p style={{ marginBottom: 6 }}>{plan.title}</p>
                <p style={{ color: "var(--ok)", marginBottom: 24 }}>
                  Time remaining: {formatTime(secondsLeft)}
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    engineRef.current?.stop();
                    setPhase("menu");
                    setPlan(null);
                    setAssets(null);
                  }}
                >
                  New Game
                </button>
              </div>
            </div>
          )}
          {phase === "lost" && (
            <div className="win-screen lost">
              <div className="card">
                <h1 className="lost-title">Time's up.</h1>
                <p style={{ marginBottom: 6 }}>{plan.title}</p>
                <p style={{ color: "var(--danger)", marginBottom: 24 }}>{plan.stakes}</p>
                <button
                  className="primary"
                  onClick={() => {
                    engineRef.current?.stop();
                    setPhase("menu");
                    setPlan(null);
                    setAssets(null);
                  }}
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===============================================================
// Sub-components
// ===============================================================

function MenuScreen(props: {
  theme: string;
  setTheme: (s: string) => void;
  seed: string;
  setSeed: (s: string) => void;
  onStart: () => void;
}) {
  return (
    <div className="menu">
      <h1>Neural Escape</h1>
      <p className="tagline">
        Every room, every prop, every puzzle is generated by AI. No two runs are the same.
      </p>

      <div className="field">
        <label htmlFor="theme">Theme (optional)</label>
        <input
          id="theme"
          placeholder="e.g. cursed library, abandoned spaceship, witch cabin"
          value={props.theme}
          onChange={(e) => props.setTheme(e.target.value)}
        />
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="seed">Seed (optional, for reproducible runs)</label>
          <input
            id="seed"
            placeholder="e.g. 42"
            value={props.seed}
            onChange={(e) => props.setSeed(e.target.value)}
          />
        </div>
      </div>

      <div className="actions">
        <button className="primary" onClick={props.onStart}>
          Generate &amp; Play
        </button>
        <button
          onClick={() => {
            props.setTheme("");
            props.setSeed("");
          }}
        >
          Reset
        </button>
      </div>

      <p className="hint">
        <b>Click any object</b> to investigate it. Pick up offerings, toggle switches,
        read murals, place items on pedestals, escape every room before the timer hits zero.
      </p>
      <p className="hint">
        First load takes ~30–60s while AI generates backgrounds and props. Assets are cached
        per-prompt in your browser, so replays are instant.
      </p>
    </div>
  );
}

function LoadingScreen({
  progress,
}: {
  progress: { done: number; total: number; log: ProgressEvent[] };
}) {
  const pct =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress.log.length]);
  return (
    <div className="loading">
      <h2>
        <span className="spinner" />
        Generating your escape room…
      </h2>
      <p className="tagline" style={{ color: "var(--muted)", margin: 0 }}>
        Calling AI for backgrounds and props. This usually takes ~45 seconds.
      </p>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-label">
        <span>{pct}%</span>
        <span>
          {progress.done} / {progress.total} assets
        </span>
      </div>
      <div className="log" ref={logRef}>
        {progress.log.map((l, i) => (
          <div key={i} className={`line ${l.level}`}>
            {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function Hud({
  plan,
  currentRoomId,
  secondsLeft,
  muted,
  onQuit,
  onToggleMute,
}: {
  plan: GamePlan;
  currentRoomId: string;
  secondsLeft: number;
  muted: boolean;
  onQuit: () => void;
  onToggleMute: () => void;
}) {
  const room = plan.rooms.find((r) => r.id === currentRoomId);
  const lowTime = secondsLeft <= 60;
  const roomNumber = plan.rooms.findIndex((r) => r.id === currentRoomId) + 1;
  return (
    <div className="hud-top">
      <div className="hud-left">
        <div className="hud-title">{plan.title}</div>
        <div className="hud-sub">
          <span className="hud-pill">
            Room {roomNumber}/{plan.rooms.length}
          </span>
          <span className="hud-mission">{room?.name ?? ""} · {plan.mission}</span>
        </div>
      </div>
      <div className="hud-right">
        <div className={`hud-timer ${lowTime ? "low" : ""}`}>
          <span className="hud-timer-label">TIME</span>
          <span className="hud-timer-value">{formatTime(secondsLeft)}</span>
        </div>
        <button className="icon-btn" onClick={onToggleMute} title={muted ? "Unmute" : "Mute"} aria-label="Toggle sound">
          {muted ? "🔇" : "🔊"}
        </button>
        <button className="icon-btn" onClick={onQuit} title="Quit to menu" aria-label="Quit">
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * Room Escape Maker-style right-side vertical inventory sidebar.
 * Shows an "Items" header and a stacked list of held items. Each item is
 * a card-style button with an icon + label. Empty state shows a quiet
 * placeholder.
 */
function InventorySidebar({
  inventory,
  invRev,
  onClick,
}: {
  inventory: string[];
  invRev: number;
  onClick: (itemId: string) => void;
}) {
  void invRev;
  return (
    <aside className="inv-side" aria-label="Inventory">
      <h2 className="inv-side-title">
        Items
        <span className="inv-side-count">{inventory.length}</span>
      </h2>
      <ul className="inv-side-list">
        {inventory.length === 0 && (
          <li className="inv-side-empty">No items collected yet.</li>
        )}
        {inventory.map((id) => (
          <li key={id}>
            <button
              className="inv-side-item"
              onClick={() => onClick(id)}
              aria-label={prettyItemName(id)}
            >
              <span className="inv-side-icon" aria-hidden="true">
                {itemEmoji(id)}
              </span>
              <span className="inv-side-label">{prettyItemName(id)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * Cursor-following tooltip showing the hovered prop's name.
 * Mirrors REM's `#tooltip-container` UX: the label gently floats above
 * the cursor and disappears as soon as you leave a hotspot.
 */
function HoverTooltip({ label, x, y }: { label: string; x: number; y: number }) {
  return (
    <div
      className="hover-tooltip"
      style={{
        left: x,
        top: y,
      }}
    >
      {label}
    </div>
  );
}

function itemEmoji(id: string): string {
  if (id.startsWith("key_")) return "🗝️";
  if (id.startsWith("code_")) return "📜";
  // Items collected from the world ("roomN_itemK") get a generic crystal
  // emoji so the slot never looks empty.
  if (/^room\d+_item\d+$/.test(id)) return "💎";
  return "📦";
}

/**
 * Bottom navigation bar — Room Escape Maker style.
 * Mirrors REM's `#game-controls`: Turn Left / Go Left / Room View N / Go
 * Right / Turn Right. The directional buttons are disabled in our
 * single-view-per-room model but kept visible so the chrome reads as a
 * "real" escape-room game.
 */
function GameNavBar({
  roomNumber,
  totalRooms,
}: {
  roomNumber: number;
  totalRooms: number;
}) {
  void totalRooms;
  return (
    <nav className="game-nav" aria-label="Room navigation">
      <button className="nav-arrow disabled" disabled aria-label="Turn Left">
        <span className="nav-arrow-icon">⏮</span>
        <span className="nav-arrow-legend">Turn Left</span>
      </button>
      <div className="nav-slider">
        <button className="nav-arrow disabled" disabled aria-label="Go Left">
          <span className="nav-arrow-icon">◀</span>
          <span className="nav-arrow-legend">Go Left</span>
        </button>
        <div className="nav-view-number">
          <span>Room View </span>
          <b>{roomNumber}</b>
        </div>
        <button className="nav-arrow disabled" disabled aria-label="Go Right">
          <span className="nav-arrow-icon">▶</span>
          <span className="nav-arrow-legend">Go Right</span>
        </button>
      </div>
      <button className="nav-arrow disabled" disabled aria-label="Turn Right">
        <span className="nav-arrow-icon">⏭</span>
        <span className="nav-arrow-legend">Turn Right</span>
      </button>
    </nav>
  );
}

/**
 * Darken a hex color by `amount` (0..1). Used to derive a floor color
 * from the room's wall color so the canvas frame mirrors REM's
 * `#canvas-background-wall` + `#canvas-background-floor` split.
 */
function darkenHex(hex: string, amount: number): string {
  const m = /^#?([a-f\d]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;
  r = Math.max(0, Math.round(r * (1 - amount)));
  g = Math.max(0, Math.round(g * (1 - amount)));
  b = Math.max(0, Math.round(b * (1 - amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}


function BriefingScreen({
  plan,
  onBegin,
  onCancel,
}: {
  plan: GamePlan;
  onBegin: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="menu briefing">
      <h1>{plan.title}</h1>
      <div className="briefing-block">
        <div className="briefing-tag">THE HOOK</div>
        <p>{plan.hook}</p>
      </div>
      <div className="briefing-block">
        <div className="briefing-tag">YOUR MISSION</div>
        <p>{plan.mission}</p>
      </div>
      <div className="briefing-block stakes">
        <div className="briefing-tag">THE STAKES</div>
        <p>{plan.stakes}</p>
      </div>
      <div className="briefing-block">
        <div className="briefing-tag">TIME ON THE CLOCK</div>
        <p className="briefing-time">{formatTime(plan.timeLimitSec)}</p>
      </div>
      <div className="actions">
        <button onClick={onCancel}>Back</button>
        <button className="primary" onClick={onBegin}>
          Begin
        </button>
      </div>
    </div>
  );
}

function formatTime(s: number): string {
  if (s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function prettyItemName(id: string): string {
  // Items now look like "room0_item2" → "Offering #3"
  const m = /^room\d+_item(\d+)$/.exec(id);
  if (m) return `Offering #${parseInt(m[1]!, 10) + 1}`;
  return id.replace(/_/g, " ");
}

function describeItem(itemId: string, plan: GamePlan): string {
  const m = /^(room\d+)_item(\d+)$/.exec(itemId);
  if (m) {
    const roomId = m[1]!;
    const room = plan.rooms.find((r) => r.id === roomId);
    return `An offering you picked up in ${room?.name ?? "an earlier room"}.\n\nIt belongs on the pedestal in that room — walk up to the pedestal and click it to place this offering.`;
  }
  return `Item: ${itemId}`;
}

function ModalView({
  modal,
  inventory,
  onClose,
  onDeposit,
}: {
  modal: ModalState;
  inventory: string[];
  onClose: () => void;
  onDeposit: (pedestal: RoomObject, itemId: string) => void;
}) {
  if (modal.kind === "info") {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>{titleForObject(modal.object)}</h3>
          <p>{modal.message ?? modal.object.description ?? "—"}</p>
          <div className="actions">
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (modal.kind === "sequence_clue") {
    const seq = modal.object.sequenceSymbols ?? [];
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>The mural</h3>
          <p>{modal.object.description ?? "Four glowing symbols are carved in this order:"}</p>
          <div className="symbol-row">
            {seq.map((s, idx) => (
              <div key={idx} className="symbol-cell">
                <div className="symbol-glyph">{s}</div>
                <div className="symbol-index">#{idx + 1}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 13, color: "var(--muted)" }}>
            Press the wall buttons in this exact order. A wrong button resets the sequence.
          </p>
          <div className="actions">
            <button className="primary" onClick={onClose}>
              Got it
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (modal.kind === "switch_clue") {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>A wiring diagram</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{modal.object.description}</p>
          <p style={{ fontSize: 13, color: "var(--muted)" }}>
            Toggle the four wall switches until they match this pattern.
          </p>
          <div className="actions">
            <button className="primary" onClick={onClose}>
              Got it
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (modal.kind === "pedestal") {
    const accepts = modal.object.acceptsItems ?? [];
    const usable = inventory.filter((it) => accepts.includes(it));
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>The pedestal</h3>
          <p>
            It has {accepts.length} empty slots. Place each offering you've collected from this
            room.
          </p>
          {usable.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>
              You don't carry anything that fits here yet. Look around for offerings on the
              floor.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {usable.map((it) => (
                <button
                  key={it}
                  className="primary"
                  onClick={() => onDeposit(modal.object, it)}
                  style={{ justifyContent: "flex-start", textAlign: "left" }}
                >
                  Place: {prettyItemName(it)}
                </button>
              ))}
            </div>
          )}
          <div className="actions">
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function titleForObject(obj: RoomObject): string {
  if (obj.id.startsWith("inv_")) return prettyItemName(obj.name);
  switch (obj.kind) {
    case "item":
      return "Offering";
    case "pedestal":
      return "The pedestal";
    case "sequence_clue":
      return "Wall mural";
    case "sequence_button":
      return "Symbol button";
    case "switch":
      return "Wall switch";
    case "switch_clue":
      return "Wiring diagram";
    case "door":
      return "Door";
    case "exit":
      return "Exit door";
    default:
      return obj.name;
  }
}
