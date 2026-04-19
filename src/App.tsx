import React, { useCallback, useEffect, useRef, useState } from "react";
import { generateProceduralPlan, PLAN_CANVAS, type GamePlan, type RoomObject } from "./shared/plan";
import { loadPlanAssets, type AssetSet, type ProgressEvent } from "./engine/assetManager";
import { GameEngine, type InteractionRequest, type InventoryItem } from "./engine/game";
import { isMuted, playWin, setMuted } from "./engine/audio";

type Phase = "menu" | "loading" | "briefing" | "playing" | "won" | "lost";

type ModalState =
  | { kind: "info"; title: string; message: string }
  | { kind: "note"; title: string; body: string }
  | {
      kind: "code";
      object: RoomObject;
      isLetters: boolean;
      length: number;
      needsKey: boolean;
      hasKey: boolean;
      error: string;
      entered: string;
    };

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
  const [equippedId, setEquippedId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // ---------------- start a game ----------------
  const startGame = useCallback(
    async (opts: { theme?: string; seed?: number }) => {
      setPhase("loading");
      setProgress({
        done: 0,
        total: 0,
        log: [{ message: "Planning your escape room…", level: "info", done: 0, total: 0 }],
      });

      let nextPlan: GamePlan | null = null;
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
          log: [
            ...p.log,
            { message: "Using offline planner (server unavailable).", level: "info", done: 0, total: 0 },
          ],
        }));
      }

      setPlan(nextPlan);

      try {
        const set = await loadPlanAssets(nextPlan, (e) => {
          setProgress((p) => {
            const log = p.log.slice(-200);
            log.push(e);
            return { done: e.done, total: e.total, log };
          });
        });
        setAssets(set);
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
        setEquippedId(null);
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

      // Required-flag gating. Doors are gated by their own `requires`
      // but we intentionally let the player *try* and see the "locked"
      // toast rather than silently nothing, so skip the generic path
      // for them.
      if (
        obj.requires &&
        obj.kind !== "door" &&
        obj.kind !== "exit" &&
        obj.kind !== "switch" && // switch shows its own hint
        !engine.hasFlag(obj.requires) &&
        !engine.hasItem(obj.requires)
      ) {
        showToast(prerequisiteHint(obj));
        return;
      }

      switch (obj.kind) {
        case "clue_note": {
          engine.readNote(obj);
          setInventoryRev((n) => n + 1);
          setModal({
            kind: "note",
            title: obj.noteTitle ?? "Note",
            body: obj.noteBody ?? obj.description ?? "",
          });
          return;
        }

        case "tool_item": {
          const r = engine.pickUpTool(obj);
          setInventoryRev((n) => n + 1);
          if (r === "picked") {
            showToast(`Picked up: ${obj.itemDisplayName ?? "item"}.`);
          } else {
            showToast("You already have that.");
          }
          return;
        }

        case "switch": {
          if (obj.requires && !engine.hasFlag(obj.requires)) {
            showToast(prerequisiteHint(obj));
            return;
          }
          const next = engine.toggleSwitch(obj);
          setInventoryRev((n) => n + 1);
          showToast(`Switch → ${next ? "ON" : "OFF"}.`);
          if (next && obj.gives && engine.hasFlag(obj.gives)) {
            setTimeout(
              () => showToast("Power restored. Something in the room just woke up."),
              300,
            );
          }
          return;
        }

        case "breakable": {
          const r = engine.tryBreak(obj);
          if (r === "broken") {
            const verb =
              obj.needsToolKind === "hammer"
                ? "smashes apart"
                : obj.needsToolKind === "screwdriver"
                  ? "comes loose"
                  : obj.needsToolKind === "knife"
                    ? "parts cleanly"
                    : "opens";
            setModal({
              kind: "info",
              title: "Opened!",
              message: `The ${objectWord(obj)} ${verb}. Something was hidden inside.`,
            });
          } else if (r === "wrong_tool") {
            showToast(
              obj.needsToolKind
                ? `You need a ${obj.needsToolKind} for this.`
                : "That won't open it.",
            );
          } else {
            showToast("It's locked. You need the right tool.");
          }
          return;
        }

        case "keypad":
        case "letter_lock": {
          const hasKey = !obj.needsKeyItemId || engine.hasItem(obj.needsKeyItemId);
          setModal({
            kind: "code",
            object: obj,
            isLetters: obj.kind === "letter_lock" || !!obj.isLetters,
            length: obj.codeLength ?? (obj.codeAnswer?.length ?? 4),
            needsKey: !!obj.needsKeyItemId,
            hasKey,
            error: "",
            entered: "",
          });
          return;
        }

        // ---------- DOOR / EXIT ----------
        case "door":
        case "exit": {
          if (!engine.isDoorUnlocked()) {
            showToast("Locked. Solve the door lock first.");
            return;
          }
          if (obj.kind === "exit") {
            setModal({
              kind: "info",
              title: "You step outside",
              message: "The exit door swings open. Freedom.",
            });
          } else {
            setModal({
              kind: "info",
              title: "Onward",
              message: "The door unlocks. You step through into the next room.",
            });
          }
          setTimeout(() => engine.advanceRoom(), 250);
          return;
        }

        default: {
          if (obj.description) {
            setModal({
              kind: "info",
              title: objectWord(obj),
              message: obj.description,
            });
          } else {
            showToast("Nothing interesting.");
          }
        }
      }
    },
    [showToast],
  );

  const submitCode = useCallback(
    (entered: string) => {
      if (!modal || modal.kind !== "code") return;
      const engine = engineRef.current;
      if (!engine) return;
      const r = engine.submitCode(modal.object, entered);
      if (r === "correct") {
        setInventoryRev((n) => n + 1);
        setModal({
          kind: "info",
          title: "It clicks open",
          message:
            "The lock disengages with a satisfying thunk. The door is now unlocked — click it to open.",
        });
      } else if (r === "needs_key") {
        setModal({
          ...modal,
          error: "You need to find the key before this lock will accept a code.",
        });
      } else {
        setModal({ ...modal, error: "Wrong. Try again.", entered: "" });
      }
    },
    [modal],
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
                    "--wall-color":
                      plan.rooms.find((r) => r.id === currentRoomId)?.ambient_color ?? "#0a0a14",
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
              items={
                engineRef.current
                  ? Array.from(engineRef.current.getState().inventory.values())
                  : []
              }
              equippedId={equippedId}
              invRev={inventoryRev}
              onClick={(item) => {
                const engine = engineRef.current;
                if (!engine) return;
                // Notes → open the reader
                if (item.noteBody) {
                  setModal({
                    kind: "note",
                    title: item.noteTitle ?? item.displayName,
                    body: item.noteBody,
                  });
                  return;
                }
                // Tool/key → toggle equip state
                const next = equippedId === item.itemId ? null : item.itemId;
                engine.equipItem(next);
                setEquippedId(next);
                if (next) {
                  showToast(`Equipped: ${item.displayName}.`);
                } else {
                  showToast(`Unequipped ${item.displayName}.`);
                }
              }}
            />
          </div>
          {hover && phase === "playing" && (
            <HoverTooltip label={hover.label} x={hover.x} y={hover.y} />
          )}
          {modal && (
            <ModalView
              modal={modal}
              onClose={() => setModal(null)}
              onType={(ch) => {
                if (!modal || modal.kind !== "code") return;
                if (modal.entered.length >= modal.length) return;
                setModal({
                  ...modal,
                  entered: modal.entered + ch,
                  error: "",
                });
              }}
              onBack={() => {
                if (!modal || modal.kind !== "code") return;
                setModal({
                  ...modal,
                  entered: modal.entered.slice(0, -1),
                  error: "",
                });
              }}
              onClear={() => {
                if (!modal || modal.kind !== "code") return;
                setModal({ ...modal, entered: "", error: "" });
              }}
              onSubmit={() => {
                if (!modal || modal.kind !== "code") return;
                submitCode(modal.entered);
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
        <b>Click any object</b> to walk to it. Read notes, flip switches, pick up tools, then
        click your tool in the inventory to <b>equip</b> it before using it on something.
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
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
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
          <span className="hud-mission">
            {room?.name ?? ""} · {plan.mission}
          </span>
        </div>
      </div>
      <div className="hud-right">
        <div className={`hud-timer ${lowTime ? "low" : ""}`}>
          <span className="hud-timer-label">TIME</span>
          <span className="hud-timer-value">{formatTime(secondsLeft)}</span>
        </div>
        <button
          className="icon-btn"
          onClick={onToggleMute}
          title={muted ? "Unmute" : "Mute"}
          aria-label="Toggle sound"
        >
          {muted ? "🔇" : "🔊"}
        </button>
        <button className="icon-btn" onClick={onQuit} title="Quit to menu" aria-label="Quit">
          ✕
        </button>
      </div>
    </div>
  );
}

function InventorySidebar({
  items,
  equippedId,
  invRev,
  onClick,
}: {
  items: InventoryItem[];
  equippedId: string | null;
  invRev: number;
  onClick: (item: InventoryItem) => void;
}) {
  void invRev;
  return (
    <aside className="inv-side" aria-label="Inventory">
      <h2 className="inv-side-title">
        Items
        <span className="inv-side-count">{items.length}</span>
      </h2>
      <ul className="inv-side-list">
        {items.length === 0 && <li className="inv-side-empty">No items collected yet.</li>}
        {items.map((item) => {
          const isEquipped = equippedId === item.itemId;
          const isNote = !!item.noteBody;
          return (
            <li key={item.itemId}>
              <button
                className={`inv-side-item ${isEquipped ? "equipped" : ""}`}
                onClick={() => onClick(item)}
                aria-label={item.displayName}
              >
                <span className="inv-side-icon" aria-hidden="true">
                  {item.emoji}
                </span>
                <span className="inv-side-label">{item.displayName}</span>
                <span className="inv-side-tag">
                  {isEquipped ? "EQUIPPED" : isNote ? "READ" : "EQUIP"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="inv-side-hint">
        {items.length > 0 && !equippedId && "Click a tool to equip it, then click what to use it on."}
        {equippedId && "Click the tool again to unequip."}
      </div>
    </aside>
  );
}

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

function GameNavBar({ roomNumber, totalRooms }: { roomNumber: number; totalRooms: number }) {
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
      <div className="briefing-block">
        <div className="briefing-tag">HOW TO PLAY</div>
        <p style={{ whiteSpace: "pre-wrap" }}>
          {[
            "• Click anything in the room — the character walks to it and interacts.",
            "• Read every note — they hold codes and hints.",
            "• Pick up tools, then click a tool in the Items panel to EQUIP it.",
            "• Equipped tools can smash glass, unscrew vents and open locks.",
            "• Find the key + code, use them on the door lock to escape.",
          ].join("\n")}
        </p>
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

function objectWord(obj: RoomObject): string {
  switch (obj.kind) {
    case "door":
      return "door";
    case "exit":
      return "exit door";
    case "switch":
      return "switch";
    case "clue_note":
      return "note";
    case "tool_item":
      return obj.itemDisplayName?.toLowerCase() ?? "item";
    case "breakable":
      return obj.name.replace(/_/g, " ");
    case "keyed_lock":
      return "lock";
    case "keypad":
      return "keypad";
    case "letter_lock":
      return "letter lock";
    default:
      return obj.name;
  }
}

function prerequisiteHint(obj: RoomObject): string {
  switch (obj.kind) {
    case "switch":
      return "You haven't found a reason to touch this yet.";
    case "tool_item":
      return "You can't see it clearly. Try something else first.";
    case "breakable":
      return "It won't budge. Something else in this room first.";
    case "keypad":
    case "letter_lock":
      return "The lock needs a code. Search the room first.";
    default:
      return "Not yet. Try something else first.";
  }
}

// ===============================================================
// Modals
// ===============================================================

function ModalView({
  modal,
  onClose,
  onType,
  onBack,
  onClear,
  onSubmit,
}: {
  modal: ModalState;
  onClose: () => void;
  onType: (ch: string) => void;
  onBack: () => void;
  onClear: () => void;
  onSubmit: () => void;
}) {
  if (modal.kind === "info") {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>{modal.title}</h3>
          <p>{modal.message}</p>
          <div className="actions">
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (modal.kind === "note") {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal note-modal" onClick={(e) => e.stopPropagation()}>
          <h3>{modal.title}</h3>
          <div className="note-paper">
            <pre>{modal.body}</pre>
          </div>
          <div className="actions">
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (modal.kind === "code") {
    const keys = modal.isLetters
      ? ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"]
      : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
    const display = modal.entered.padEnd(modal.length, "•");
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal code-modal" onClick={(e) => e.stopPropagation()}>
          <h3>{modal.isLetters ? "Letter lock" : "Keypad"}</h3>
          {modal.needsKey && !modal.hasKey && (
            <p className="err-msg">
              The lock won't accept a code without the key. Find the key first.
            </p>
          )}
          <div className="digits">{display}</div>
          <div className="err-msg">{modal.error}</div>
          <div className={`code-grid ${modal.isLetters ? "letters" : "digits-grid"}`}>
            {keys.map((k) => (
              <button key={k} onClick={() => onType(k)}>
                {k}
              </button>
            ))}
          </div>
          <div className="actions">
            <button onClick={onClear}>Clear</button>
            <button onClick={onBack}>⌫ Back</button>
            <button onClick={onClose}>Cancel</button>
            <button
              className="primary"
              disabled={modal.entered.length !== modal.length || (modal.needsKey && !modal.hasKey)}
              onClick={onSubmit}
            >
              Enter
            </button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
