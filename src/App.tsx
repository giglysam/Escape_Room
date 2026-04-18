import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateProceduralPlan, PLAN_CANVAS, type GamePlan, type RoomObject, type RoomPlan } from "./shared/plan";
import { loadPlanAssets, type AssetSet, type ProgressEvent } from "./engine/assetManager";
import { GameEngine, type InteractionRequest } from "./engine/game";

type Phase = "menu" | "loading" | "playing" | "won";

interface ModalState {
  kind: "info" | "keypad" | "riddle" | "container" | "door";
  object: RoomObject;
  message?: string;
}

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
        setPhase("playing");
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
        setPhase("won");
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
  const handleInteract = useCallback((req: InteractionRequest) => {
    const engine = engineRef.current;
    if (!engine) return;
    const obj = req.object;

    switch (obj.kind) {
      case "note": {
        setModal({ kind: "riddle", object: obj });
        return;
      }
      case "keypad": {
        setModal({ kind: "keypad", object: obj });
        return;
      }
      case "container": {
        const required = obj.requires;
        if (required && !engine.hasFlag(required) && !engine.hasItem(required)) {
          showToast("It won't budge. You need to figure something out first.");
          return;
        }
        if (obj.gives && !engine.hasItem(obj.gives)) {
          engine.giveItem(obj.gives);
          setInventoryRev((n) => n + 1);
          const isCode = obj.gives.startsWith("code_");
          const message = isCode
            ? `Inside, you find a slip of paper. It reads:\n\n  ${getRoomCodeFromGive(obj, req.room)}\n\nThe keypad calls.`
            : `You take the ${obj.gives}.`;
          setModal({ kind: "info", object: obj, message });
        } else {
          showToast("Empty.");
        }
        return;
      }
      case "door":
      case "exit": {
        const need = obj.requires;
        if (need && !engine.hasItem(need)) {
          showToast("Locked. You need a key.");
          return;
        }
        // unlocked!
        if (obj.kind === "exit") {
          setModal({
            kind: "info",
            object: obj,
            message: "You slide the key in. The exit door clunks open. Freedom.",
          });
          // Delay the win until they dismiss
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
      case "key":
      case "tool": {
        if (obj.gives) {
          engine.giveItem(obj.gives);
          setInventoryRev((n) => n + 1);
          showToast(`Picked up: ${obj.gives}`);
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
  }, [showToast]);

  // helper — find the keypad code in the same room as the container
  const getRoomCodeFromGive = (containerObj: RoomObject, room: RoomPlan): string => {
    void containerObj;
    const keypad = room.objects.find((o) => o.kind === "keypad");
    return keypad?.solution ?? "????";
  };

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

      {(phase === "playing" || phase === "won") && plan && assets && (
        <div className="game-wrap">
          <canvas
            ref={canvasRef}
            className="game-canvas"
            width={PLAN_CANVAS.width}
            height={PLAN_CANVAS.height}
            style={{
              aspectRatio: `${PLAN_CANVAS.width} / ${PLAN_CANVAS.height}`,
              width: "min(100%, 1280px)",
            }}
          />
          <Hud
            plan={plan}
            currentRoomId={currentRoomId}
            inventory={engineRef.current ? Array.from(engineRef.current.getState().inventory) : []}
            invRev={inventoryRev}
            onQuit={() => {
              engineRef.current?.stop();
              setPhase("menu");
              setPlan(null);
              setAssets(null);
            }}
          />
          {modal && (
            <ModalView
              modal={modal}
              onClose={() => setModal(null)}
              onSolveRiddle={(noteObj, ok) => {
                const engine = engineRef.current;
                if (!engine) return;
                if (ok) {
                  engine.solveRiddle(noteObj.id);
                  setInventoryRev((n) => n + 1);
                  setModal({
                    kind: "info",
                    object: noteObj,
                    message:
                      "A panel slides aside revealing a hidden compartment in this room — try the container nearby.",
                  });
                } else {
                  showToast(noteObj.hint ?? "That's not it.");
                }
              }}
              onSubmitKeypad={(kpObj, code) => {
                const engine = engineRef.current;
                if (!engine) return;
                if (code === kpObj.solution) {
                  if (kpObj.gives) {
                    engine.giveItem(kpObj.gives);
                    setInventoryRev((n) => n + 1);
                  }
                  setModal({
                    kind: "info",
                    object: kpObj,
                    message: "Click! A key card pops out of the slot. Picked up!",
                  });
                } else {
                  showToast(kpObj.hint ?? "Wrong code.");
                }
              }}
            />
          )}
          {toast && <div className="toast">{toast}</div>}
          {phase === "won" && (
            <div className="win-screen">
              <div className="card">
                <h1>You escaped.</h1>
                <p>{plan.title}</p>
                <button
                  className="primary"
                  onClick={() => {
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
        Controls: <b>WASD</b> or <b>arrow keys</b> to move · <b>E</b> / <b>Space</b> /
        <b> click</b> to interact · solve riddles, find codes, escape each room.
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
  inventory,
  invRev,
  onQuit,
}: {
  plan: GamePlan;
  currentRoomId: string;
  inventory: string[];
  invRev: number;
  onQuit: () => void;
}) {
  const room = plan.rooms.find((r) => r.id === currentRoomId);
  // touch invRev so React rerenders when inventory mutates in-place
  void invRev;
  return (
    <div className="hud">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="panel title">{plan.title}</div>
        <div className="panel">
          {room?.name ?? ""} · Room {(plan.rooms.findIndex((r) => r.id === currentRoomId) + 1)}/
          {plan.rooms.length}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
        <div className="panel">
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>INVENTORY</div>
          <div className="inventory">
            {inventory.length === 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>empty</span>}
            {inventory.map((it) => (
              <span key={it} className="inv-chip">
                {prettyItemName(it)}
              </span>
            ))}
          </div>
        </div>
        <button onClick={onQuit}>Quit to menu</button>
      </div>
    </div>
  );
}

function prettyItemName(id: string): string {
  if (id.startsWith("key_")) return "Key card";
  if (id.startsWith("code_")) return "Code slip";
  return id.replace(/_/g, " ");
}

function ModalView({
  modal,
  onClose,
  onSolveRiddle,
  onSubmitKeypad,
}: {
  modal: ModalState;
  onClose: () => void;
  onSolveRiddle: (obj: RoomObject, correct: boolean) => void;
  onSubmitKeypad: (obj: RoomObject, code: string) => void;
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
  if (modal.kind === "riddle") {
    return <RiddleModal obj={modal.object} onClose={onClose} onSolve={onSolveRiddle} />;
  }
  if (modal.kind === "keypad") {
    return <KeypadModal obj={modal.object} onClose={onClose} onSubmit={onSubmitKeypad} />;
  }
  return null;
}

function titleForObject(obj: RoomObject): string {
  switch (obj.kind) {
    case "note":
      return "A handwritten note";
    case "keypad":
      return "Electronic keypad";
    case "container":
      return "Container";
    case "door":
      return "Door";
    case "exit":
      return "Exit door";
    default:
      return obj.name;
  }
}

function RiddleModal({
  obj,
  onClose,
  onSolve,
}: {
  obj: RoomObject;
  onClose: () => void;
  onSolve: (obj: RoomObject, correct: boolean) => void;
}) {
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const submit = () => {
    if (!val.trim()) return;
    const ok =
      val.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "") ===
      (obj.solution ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
    if (ok) {
      onSolve(obj, true);
    } else {
      setErr(obj.hint ?? "Not quite. Think again.");
      onSolve(obj, false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>A handwritten note</h3>
        <p>{obj.riddle}</p>
        <input
          autoFocus
          placeholder="Your answer…"
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          style={{ width: "100%", marginTop: 12 }}
        />
        <div className="err-msg">{err}</div>
        <div className="actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={submit}>
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}

function KeypadModal({
  obj,
  onClose,
  onSubmit,
}: {
  obj: RoomObject;
  onClose: () => void;
  onSubmit: (obj: RoomObject, code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const press = (d: string) => {
    if (code.length >= 4) return;
    setErr("");
    setCode((c) => c + d);
  };
  const back = () => setCode((c) => c.slice(0, -1));
  const submit = () => {
    if (code.length !== 4) {
      setErr("Enter 4 digits.");
      return;
    }
    if (code === obj.solution) {
      onSubmit(obj, code);
    } else {
      setErr("Access denied.");
      setCode("");
      onSubmit(obj, code);
    }
  };
  const digits = useMemo(() => ["1", "2", "3", "4", "5", "6", "7", "8", "9"], []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Electronic keypad</h3>
        <div className="digits">{code.padEnd(4, "•")}</div>
        <div className="err-msg">{err}</div>
        <div className="keypad">
          {digits.map((d) => (
            <button key={d} onClick={() => press(d)}>
              {d}
            </button>
          ))}
          <button onClick={back}>⌫</button>
          <button onClick={() => press("0")}>0</button>
          <button className="primary" onClick={submit}>
            ✓
          </button>
        </div>
        <div className="actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
