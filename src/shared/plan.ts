/**
 * Procedural escape-room plan generator.
 *
 * Builds REM-style multi-step rooms where each room is a chain of 8
 * concrete puzzles: find clues, pick up tools, use tools to break open
 * containers, unlock the exit with a key + code.
 *
 * Pure TS, no DOM / no Node deps — usable from both Vercel serverless
 * functions and the browser client (offline fallback).
 */

export interface PlanReq {
  theme?: string;
  difficulty?: "easy" | "normal" | "hard";
  rooms?: number;
  seed?: number;
}

/**
 * Semantic class of every scene object.
 *
 *   door / exit          — the way to the next room / end of game.
 *   decoration           — pure atmosphere, no interaction.
 *   switch               — wall toggle; flipping sets a flag.
 *   clue_note            — a note/letter/scrap on the floor or wall;
 *                          clicking reads it (a modal) and adds a copy
 *                          to the inventory so it can be re-read.
 *   tool_item            — a tool or key on the floor; clicking picks it
 *                          up (removes from the world, adds to inv).
 *   breakable            — a locked container/glass/vent that requires
 *                          a matching TOOL to open. Once broken it
 *                          vanishes and reveals its hidden children.
 *   keyed_lock           — like breakable but needs a specific KEY
 *                          (inventory item id), and the key is consumed.
 *   keypad               — click → numeric keypad modal, 4 digits.
 *   letter_lock          — click → 4-letter dial modal.
 *   pedestal             — altar; accept one or more inventory items.
 *   sequence_button / sequence_clue — kept for legacy callers but unused.
 *   switch_clue          — legacy, unused.
 *   item                 — legacy, unused (replaced by tool_item).
 */
export type ObjectKind =
  | "door"
  | "exit"
  | "decoration"
  | "switch"
  | "clue_note"
  | "tool_item"
  | "breakable"
  | "keyed_lock"
  | "keypad"
  | "letter_lock"
  | "pedestal"
  // legacy — kept only so external callers keep compiling
  | "item"
  | "sequence_clue"
  | "sequence_button"
  | "switch_clue";

/**
 * Tools the engine understands. A `breakable` with `needsToolKind: "hammer"`
 * is opened by a `tool_item` with `toolKind: "hammer"`.
 */
export type ToolKind = "hammer" | "screwdriver" | "knife" | "crowbar" | "key";

export interface RoomObject {
  id: string;
  name: string;
  prompt: string;
  x: number;
  y: number;
  width: number;
  height: number;
  collidable: boolean;
  interactable: boolean;
  removeBackground: boolean;
  kind: ObjectKind;

  /**
   * Flag that must be set (OR an inventory item id that must be held)
   * before this object can be used. If missing, the engine shows a
   * themed toast and no-ops.
   */
  requires?: string;
  /** Flag this object emits on successful use. */
  gives?: string;
  /** Description shown in info popups / modal headers. */
  description?: string;
  /** Hint shown after a wrong attempt (kept for future use). */
  hint?: string;
  /**
   * If set, this object is invisible AND non-interactable until the
   * flag is present in GameState.flags. Used to hide children of a
   * breakable / keyed_lock until it's been opened.
   */
  hiddenUntilFlag?: string;

  // ---------------- Inventory item metadata ----------------
  //
  // These fields describe "what the player receives" when they click
  // a tool_item or a clue_note. The inventory stores the itemId; the
  // display name / emoji / description let the UI render a pretty tile.

  /** Unique inventory id — e.g. `hammer_r0`, `key_r1`, `note_a_r0`. */
  itemId?: string;
  /** User-facing name — e.g. "Hammer", "Brass Key", "Crumpled Note". */
  itemDisplayName?: string;
  /** Emoji for the inventory tile. */
  itemEmoji?: string;
  /** Category of tool, used to match breakables. */
  toolKind?: ToolKind;

  // ---------------- Break / lock / code data ----------------

  /** `breakable`: kind of tool needed to break it open. */
  needsToolKind?: ToolKind;
  /** `keyed_lock`: inventory itemId required. Key is consumed. */
  needsKeyItemId?: string;
  /** `keypad`/`letter_lock`: the correct code (e.g. "7413" or "MOON"). */
  codeAnswer?: string;
  /** `keypad`/`letter_lock`: length of the code. */
  codeLength?: number;
  /** `letter_lock` only. */
  isLetters?: boolean;

  // ---------------- Note / clue data ----------------

  /** `clue_note`: the full text the modal displays. */
  noteBody?: string;
  /** `clue_note`: short label shown on the inventory tile ("Note A"). */
  noteTitle?: string;

  // ---------------- Legacy archetype fields (unused by new rooms) ----------------
  symbol?: string;
  symbolIndex?: number;
  initialOn?: boolean;
  targetOn?: boolean;
  acceptsItems?: string[];
  sequenceSymbols?: string[];
}

export interface RoomPlan {
  id: string;
  name: string;
  background_prompt: string;
  ambient_color: string;
  objects: RoomObject[];
  intro: string;
}

export interface GamePlan {
  title: string;
  story: string;
  difficulty: string;
  mission: string;
  hook: string;
  stakes: string;
  timeLimitSec: number;
  rooms: RoomPlan[];
}

// Match Room Escape Maker's 1280x720 (16:9) standard so AI-generated
// backgrounds line up with the chrome around the canvas.
const W = 1280;
const H = 720;
const FLOOR_TOP = 410;

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

interface ThemeDef {
  title: string;
  story: string;
  mission: string;
  hook: string;
  stakes: string;
  /** One background prompt per room. */
  bgs: string[];
  /** Display name per room. */
  rooms: string[];
  ambient: string[];
  /** Door prompt per room. */
  doorPrompts: string[];
  /** Wall decoration pool — purely atmospheric. */
  decoStyles: string[];

  /** Prompt for the first crumpled note found on the floor. */
  noteAPrompt: string;
  /** Prompt for the note found inside the glass case. */
  noteBPrompt: string;
  /** Prompt for the wall switch. */
  switchPrompt: string;
  /** Prompt for a glass display case mounted on the wall. */
  glassCasePrompt: string;
  /** Prompt for an air vent / grate on the wall. */
  ventPrompt: string;
  /** Prompt for a locked metal briefcase on the floor. */
  briefcasePrompt: string;
  /** Prompt for a wooden crate / shipping box (crowbar-openable). */
  cratePrompt: string;
  /** Prompt for the hammer cutout. */
  hammerPrompt: string;
  /** Prompt for the screwdriver cutout. */
  screwdriverPrompt: string;
  /** Prompt for the knife cutout (unused in baseline, reserved). */
  knifePrompt: string;
  /** Prompt for a crowbar cutout. */
  crowbarPrompt: string;
  /** Prompt for a brass key cutout. */
  keyPrompt: string;
}

const BG_STYLE =
  "interior wide shot, side-scrolling 2D perspective view, single empty room with back wall and floor visible, no characters, no people, no creatures, no text, cinematic lighting, ultra detailed concept art, painterly, 16:9";

const THEMES: ThemeDef[] = [
  {
    title: "Neural Lab Breakout",
    story:
      "You wake inside a rogue AI research lab. Self-destruct in T-minus unknown. Find the override codes and escape before the neural core melts down.",
    mission: "Reach the surface airlock before the neural core melts down.",
    hook: "An encrypted ping woke you in cold storage. The lab is on emergency power, the AI is still online, and only the maintenance corridors are unlocked.",
    stakes:
      "If you fail, the core breaches and the entire research wing — and you with it — is reduced to slag.",
    bgs: [
      `dark futuristic AI laboratory wall and floor, glowing blue panel textures on the back wall, polished metal floor, holographic ambient particles, completely empty room interior, ${BG_STYLE}`,
      `abandoned cyberpunk server room wall and floor, red emergency rim lighting, tangled fiber-optic light traces glowing on the wall, dusty metal grating floor, completely empty room interior, ${BG_STYLE}`,
      `secret AI vault wall and floor, glowing lines of source code projected on the back wall, polished obsidian floor with subtle reflections, completely empty room interior, ${BG_STYLE}`,
    ],
    rooms: ["Control Room", "Server Vault", "Core Chamber"],
    ambient: ["#0b1424", "#1a0a14", "#0a1a18"],
    doorPrompts: [
      "heavy futuristic sealed sliding metal door with glowing blue accents",
      "armored bulkhead door with red status light, sci-fi",
      "massive vault door covered in glowing circuit lines",
    ],
    decoStyles: [
      "small vintage desktop server tower with blinking LEDs",
      "small tangle of fiber optic cables glowing blue",
      "broken holographic projector device",
    ],
    noteAPrompt: "crumpled futuristic paper note with handwritten ink",
    noteBPrompt: "folded data card with a short handwritten four-digit sequence",
    switchPrompt:
      "industrial wall mounted heavy duty toggle switch with red and green indicator light, sci-fi",
    glassCasePrompt:
      "small wall-mounted reinforced glass display case containing a tool, sci-fi",
    ventPrompt:
      "rectangular wall-mounted metal air vent grate with four visible screws, sci-fi",
    briefcasePrompt: "small scuffed metal briefcase with a combination lock, sci-fi",
    cratePrompt: "small wooden shipping crate with boards and nails, sci-fi cargo",
    hammerPrompt: "small heavy rubber grip claw hammer",
    screwdriverPrompt: "small phillips head screwdriver with a yellow handle",
    knifePrompt: "small utility knife with a retractable blade",
    crowbarPrompt: "small steel crowbar with a worn grip",
    keyPrompt: "small brass door key with a round bow",
  },
  {
    title: "Beirut Antiquarian Heist",
    story:
      "You're locked in a forgotten antique shop in old Beirut. Lebanese mosaics hide ancient mechanisms. Crack them before dawn or be sealed in forever.",
    mission: "Reach the rooftop courtyard before the call to dawn prayer.",
    hook:
      "The collector who hired you vanished an hour ago. The shop's door bolted itself the moment you stepped inside, and the mosaics on the walls have started glowing.",
    stakes:
      "At first light the building's ancient lock-stones fuse permanently — you stay buried with the artifacts forever.",
    bgs: [
      `interior wall and floor of an old Beirut antique shop, dusty hand-painted wall plaster, faded patterned tile floor, warm amber lamplight from off-screen, completely empty room interior, ${BG_STYLE}`,
      `interior wall and floor of a phoenician hidden chamber, hand-carved stone wall with weathered glyph textures, smooth flagstone floor, flickering torchlight from off-screen, completely empty room interior, ${BG_STYLE}`,
      `outdoor rooftop courtyard above old Beirut at night, moonlit ornate stone wall in the back, polished marble floor, soft blue night light, completely empty courtyard, ${BG_STYLE}`,
    ],
    rooms: ["Antique Shop", "Hidden Chamber", "Rooftop Exit"],
    ambient: ["#1a1208", "#0e0a06", "#0a1018"],
    doorPrompts: [
      "old ornate carved wooden door with brass handle",
      "heavy ancient stone door covered in phoenician carvings",
      "tall arched ornate cedar door covered in islamic geometric carvings",
    ],
    decoStyles: [
      "ornate ottoman oil lamp glowing",
      "stack of dusty old leather books",
      "brass arabian teapot",
    ],
    noteAPrompt: "yellowed torn parchment with handwritten arabic ink",
    noteBPrompt: "small folded parchment with a four-digit numeric inscription",
    switchPrompt:
      "antique brass wall lever with two positions and an engraved indicator, ornate ottoman style",
    glassCasePrompt:
      "small wall-mounted antique glass museum display case containing a tool, ornate wooden frame",
    ventPrompt:
      "rectangular wall-mounted ornamental brass grille with four visible screws",
    briefcasePrompt: "small worn leather travel case with a brass combination dial",
    cratePrompt: "small antique wooden storage crate with rope handles",
    hammerPrompt: "small antique iron blacksmith hammer with a worn wooden handle",
    screwdriverPrompt: "small antique brass flathead screwdriver with a wooden handle",
    knifePrompt: "small ornate ottoman letter opener with an engraved blade",
    crowbarPrompt: "small iron pry bar with a wrapped leather grip, antique",
    keyPrompt: "small ornate ottoman brass skeleton key",
  },
  {
    title: "Derelict Starship Sigma",
    story:
      "Cryo-sleep failed. The starship Sigma is silent and the airlock is sealed. Reroute power, override the captain's lock, reach the escape pod.",
    mission: "Reach Escape Pod Bay 3 before life support runs out.",
    hook:
      "Your cryo-pod popped open hours after the rest of the crew vanished. Comms are dead. The ship is drifting toward a star, and atmospheric pressure is dropping by the minute.",
    stakes: "Fail and the hull boils away as Sigma falls into the corona — you are vapor.",
    bgs: [
      `interior wall and floor of a derelict spaceship corridor, riveted metal hull walls, scuffed grated floor, flickering cool ceiling light from off-screen, floating dust particles, completely empty corridor interior, ${BG_STYLE}`,
      `interior wall and floor of a spaceship engine room, scorched metal back wall with faint glowing fracture lines, oil-stained metal floor, hot orange rim lighting, sparks falling off-screen, completely empty room interior, ${BG_STYLE}`,
      `interior wall and floor of a spaceship escape pod bay, smooth white hull wall, polished metal floor, pulsing red emergency rim light, completely empty bay interior, ${BG_STYLE}`,
    ],
    rooms: ["Corridor", "Engine Room", "Pod Bay"],
    ambient: ["#06101a", "#1a0c06", "#040a14"],
    doorPrompts: [
      "sealed sci-fi airlock door with porthole window",
      "armored engineering bulkhead door with rivets",
      "circular escape pod hatch with red warning light",
    ],
    decoStyles: [
      "broken engineering helmet",
      "sparking power conduit segment",
      "floating zero-gravity coffee mug",
    ],
    noteAPrompt: "crumpled paper log torn from a mission logbook",
    noteBPrompt: "folded control panel schematic with a four-digit override code",
    switchPrompt:
      "spaceship wall mounted breaker switch with status LED, industrial sci-fi",
    glassCasePrompt:
      "small wall-mounted reinforced glass equipment case containing a tool, sci-fi",
    ventPrompt:
      "rectangular spaceship wall air vent grate with four visible hex screws, sci-fi",
    briefcasePrompt: "small pressurised equipment case with a keypad, sci-fi",
    cratePrompt: "small metal cargo crate with stencilled hazard markings, sci-fi",
    hammerPrompt: "small emergency rubber mallet with a yellow handle",
    screwdriverPrompt: "small hex screwdriver with a black grip",
    knifePrompt: "small utility blade with a stainless steel sheath",
    crowbarPrompt: "small titanium emergency pry tool, sci-fi",
    keyPrompt: "small magnetic command key card on a lanyard",
  },
  {
    title: "Witch's Mountain Cabin",
    story:
      "You sheltered from a storm in a cabin that locked behind you. Old runes and bubbling potions hint at a way out — if you can read them in time.",
    mission: "Reach the forest gate before the witch returns from her hunt.",
    hook:
      "The storm chased you into a cabin you didn't choose. The door slammed itself shut and the candles lit themselves the moment you crossed the threshold.",
    stakes:
      "When the witch comes home she'll add you to her shelf of curiosities — labelled and preserved.",
    bgs: [
      `interior wall and floor of an old witch wooden cabin, weathered timber plank wall, dusty wooden floor, warm flickering candlelight from off-screen, drifting smoke, completely empty cabin interior, ${BG_STYLE}`,
      `interior wall and floor of a stone cellar under a witch cabin, damp moss-covered stone wall, runic circle softly glowing on the stone floor, faint green torchlight, completely empty cellar interior, ${BG_STYLE}`,
      `outdoor moonlit forest clearing at night, dark dense forest as the back wall, soft mossy ground as the floor, cold blue moonlight, drifting fog, completely empty clearing, ${BG_STYLE}`,
    ],
    rooms: ["Cabin", "Cellar", "Forest Gate"],
    ambient: ["#100a04", "#08040a", "#040a08"],
    doorPrompts: [
      "old creaky wooden plank door with iron hinges",
      "heavy stone cellar door with iron rivets",
      "tall iron forest gate covered in glowing runes",
    ],
    decoStyles: [
      "bubbling green potion bottle",
      "old wooden broomstick",
      "stack of spellbooks bound in leather",
    ],
    noteAPrompt: "old torn yellow parchment with hand-scrawled ink runes",
    noteBPrompt: "folded scrap of parchment with a four-letter word carved into it",
    switchPrompt:
      "old iron wall lever with a glowing rune indicator, mystical witch style",
    glassCasePrompt:
      "small wall-mounted glass reliquary case containing a tool, witch style",
    ventPrompt:
      "rectangular wall-mounted wooden grate with four visible iron screws, witch style",
    briefcasePrompt: "small weathered wooden chest with iron bands",
    cratePrompt: "small wooden crate bound with iron straps, witch cellar style",
    hammerPrompt: "small blacksmith iron hammer with a wooden handle",
    screwdriverPrompt: "small antique iron flathead screwdriver with a wooden handle",
    knifePrompt: "small ornate ritual silver athame knife with a carved handle",
    crowbarPrompt: "small iron witch-forged crowbar with twisted metal",
    keyPrompt: "small ornate iron skeleton key with a ring bow",
  },
];

/**
 * Builds a deeply theme-driven `ThemeDef` from a freeform user phrase.
 */
function buildCustomTheme(theme: string): ThemeDef {
  const t = theme.trim();
  const vibe = (room: "entrance" | "heart" | "exit") => {
    const moodWords =
      room === "entrance"
        ? "first impression, threshold, sense of arrival, slight tension"
        : room === "heart"
          ? "deepest part of the place, heavy atmosphere, sense of revelation"
          : "way out close at hand, hopeful glow, wider space, sense of release";
    return [
      `everything in this scene must feel like it truly belongs to the world of ${t}`,
      `materials, textures, color palette, lighting and mood are 100% derived from ${t}`,
      "atmospheric depth, painterly background art, cinematic concept art quality",
      moodWords,
    ].join(", ");
  };

  return {
    title: `Custom Run · ${t}`,
    story: `You are trapped inside the world of ${t}. Each room reveals a different facet of ${t}, and only by mastering them can you escape.`,
    mission: `Escape the world of ${t} before time runs out.`,
    hook: `You woke up inside the world of ${t}. Everything around you — the air, the textures, the light — is unmistakably of ${t}. The way you came in has sealed itself behind you.`,
    stakes: `If the timer hits zero, the world of ${t} closes around you forever and you become part of it.`,
    rooms: [`Threshold of ${t}`, `Heart of ${t}`, `Way Out of ${t}`],
    ambient: ["#0c0c18", "#180c10", "#0a1018"],
    bgs: [
      `the threshold of the world of ${t}, completely empty room interior with only the back wall and floor visible, walls and floor textures fully derived from ${t}, ${vibe("entrance")}, ${BG_STYLE}`,
      `the heart of the world of ${t}, completely empty room interior with only the back wall and floor visible, walls and floor textures fully derived from ${t}, ${vibe("heart")}, ${BG_STYLE}`,
      `the way out of the world of ${t}, completely empty room interior with only the back wall and floor visible, walls and floor textures fully derived from ${t}, ${vibe("exit")}, ${BG_STYLE}`,
    ],
    doorPrompts: [
      `tall closed door entirely made of materials and motifs from the world of ${t}, every surface, color and detail is unmistakably ${t}`,
      `heavy decorated door entirely made of materials and motifs from the world of ${t}, ornate, every detail screams ${t}`,
      `tall final exit door entirely made of materials and motifs from the world of ${t}, glowing edges, every detail unmistakably ${t}`,
    ],
    decoStyles: [
      `iconic small object that immediately reads as ${t}`,
      `small everyday prop that someone living inside the world of ${t} would own`,
      `small symbolic relic of ${t}`,
    ],
    noteAPrompt: `small crumpled paper note, the paper texture and ink match the world of ${t}`,
    noteBPrompt: `small folded note with a four-character code written on it, paper and ink materials from the world of ${t}`,
    switchPrompt: `wall mounted toggle switch sculpted from materials of ${t}, fits the world of ${t}`,
    glassCasePrompt: `small wall-mounted glass display case containing a tool, frame materials from the world of ${t}`,
    ventPrompt: `small wall-mounted grate with four visible screws, materials from the world of ${t}`,
    briefcasePrompt: `small locked portable case with a combination lock, made from materials of ${t}`,
    cratePrompt: `small wooden crate whose wood and straps match the world of ${t}`,
    hammerPrompt: `small hammer whose materials and handle come from the world of ${t}`,
    screwdriverPrompt: `small screwdriver whose materials come from the world of ${t}`,
    knifePrompt: `small hand knife whose materials come from the world of ${t}`,
    crowbarPrompt: `small steel crowbar pry bar whose finish matches the world of ${t}`,
    keyPrompt: `small ornate key whose shape and material are unmistakably ${t}`,
  };
}

export const PLAN_CANVAS = { width: W, height: H, floorTop: FLOOR_TOP };

/** Upstream image API rejects prompts longer than this. */
const BG_PROMPT_MAX_LEN = 2000;

/** Integer plan-space rectangle for 1280×720 REM-style placement. */
function pxRect(x: number, y: number, width: number, height: number) {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Stable micro-jitter so each room/variant reads differently without breaking bands. */
function spread(roomIndex: number, chainKind: number, salt: number, mag: number): number {
  const v = ((roomIndex * 17 + chainKind * 31 + salt * 13) % (mag * 2 + 1)) - mag;
  return v;
}

function clampBgPrompt(s: string): string {
  if (s.length <= BG_PROMPT_MAX_LEN) return s;
  return s.slice(0, BG_PROMPT_MAX_LEN - 1).trimEnd() + "…";
}

const OBJ_STYLE =
  "single small object only, centered subject, " +
  "background is a pure flat solid white #ffffff color filling the entire image, " +
  "no gradient, no texture, no pattern, no scene, no surface, no shadow, no reflection, " +
  "isolated cutout product photo style, " +
  "no environment, no room, no building, no house, no cabin, no architecture, " +
  "no people, no creatures, no text, no logos, " +
  "ultra detailed, sharp focus, even lighting";

// ===============================================================
// Public API
// ===============================================================

export function generateProceduralPlan(req: PlanReq = {}): GamePlan {
  const seed = req.seed ?? Math.floor(Math.random() * 1e9);
  const rng = mulberry32(seed);

  const base: ThemeDef = req.theme ? buildCustomTheme(req.theme) : pick(rng, THEMES);
  const titleOverride = base.title;

  const numRooms = Math.max(2, Math.min(3, req.rooms ?? 3));

  const rooms: RoomPlan[] = [];
  for (let i = 0; i < numRooms; i++) {
    const room = buildToolChainRoom(rng, base, i, numRooms, seed);
    room.background_prompt = composeBackgroundPrompt(room, base, i);
    rooms.push(room);
  }

  const difficulty = req.difficulty ?? "normal";
  const baseSeconds = difficulty === "easy" ? 720 : difficulty === "hard" ? 480 : 600;

  return {
    title: titleOverride,
    story: base.story,
    difficulty,
    mission: base.mission,
    hook: base.hook,
    stakes: base.stakes,
    timeLimitSec: baseSeconds,
    rooms,
  };
}

// ===============================================================
// Background prompt — always empty themed room, no painted props.
// ===============================================================

/**
 * Background prompt: empty themed shell + **exact pixel voids** for every
 * cutout (same 1280×720 grid as gameplay). Hard-capped at 2000 chars for the
 * image API — we shrink by trimming prose, then dropping low-priority rects.
 */
function composeBackgroundPrompt(room: RoomPlan, base: ThemeDef, i: number): string {
  const sceneBaseRaw = base.bgs[i] ?? base.bgs[0]!;
  const sceneBase =
    sceneBaseRaw.length > 420 ? `${sceneBaseRaw.slice(0, 417).trimEnd()}…` : sceneBaseRaw;

  const core =
    `Empty ${W}x${H}px escape-room backdrop only: wall y=0–${FLOOR_TOP - 1}, floor y=${FLOOR_TOP}–${H - 1}, ` +
    `orthographic straight-on, continuous texture, no props. ` +
    `Leave each VOID as blank wall/floor paint (PNG props snap to these pixels): `;

  const forbid = " Forbidden: doors, locks, vents, cases, notes, tools, people, text, UI.";

  const sorted = [...room.objects].sort((a, b) => {
    const cyA = a.y + a.height / 2;
    const cyB = b.y + b.height / 2;
    if (Math.abs(cyA - cyB) > 8) return cyA - cyB;
    return a.x - b.x;
  });

  /** Compact rect: name@x,y,w,h band (W=wall F=floor) */
  function rectLine(o: RoomObject): string {
    const cy = Math.round(o.y + o.height / 2);
    const band = cy < FLOOR_TOP ? "W" : "F";
    const tag = `${o.kind}:${o.name}`.slice(0, 28);
    return `${tag}@${o.x},${o.y},${o.width},${o.height},${band}`;
  }

  const priority = (o: RoomObject) => {
    if (o.kind === "door" || o.kind === "exit") return 0;
    if (o.kind === "keypad" || o.kind === "letter_lock") return 1;
    if (o.kind !== "decoration") return 2;
    return 3;
  };

  function buildLines(objs: RoomObject[]): string {
    return objs.map(rectLine).join(" | ");
  }

  // Try full list, then drop decorations, then drop half of remaining, etc.
  let candidates = sorted;
  let lines = buildLines(candidates);
  let out = `${sceneBase} ${core}${lines}.${forbid}`;

  const shrink = () => {
    candidates = candidates.filter((o) => priority(o) < 3);
    lines = buildLines(candidates);
    out = `${sceneBase} ${core}${lines}.${forbid}`;
  };

  if (out.length > BG_PROMPT_MAX_LEN) shrink();

  while (out.length > BG_PROMPT_MAX_LEN && candidates.length > 6) {
    // Drop lowest-priority tail (keep door + lock + main chain)
    const byPri = [...candidates].sort((a, b) => priority(a) - priority(b));
    byPri.pop();
    candidates = byPri;
    lines = buildLines(candidates);
    out = `${sceneBase} ${core}${lines}.${forbid}`;
  }

  let scene = sceneBase;
  while (out.length > BG_PROMPT_MAX_LEN && scene.length > 140) {
    scene = scene.slice(0, Math.max(120, scene.length - 48)).trimEnd() + "…";
    out = `${scene} ${core}${lines}.${forbid}`;
  }

  return clampBgPrompt(out);
}

// ===============================================================
// Room builders
// ===============================================================

interface RoomLayout {
  WALL_TOP: number;
  WALL_BOT: number;
  FLOOR_BOT: number;
  doorX: number;
  doorY: number;
  doorW: number;
  doorH: number;
}

function makeLayout(): RoomLayout {
  const WALL_TOP = 120;
  const WALL_BOT = FLOOR_TOP - 10;
  const FLOOR_BOT = H - 30;
  const doorW = 200;
  const doorH = 440;
  const doorX = Math.round(W - doorW - 60);
  const doorY = Math.round(FLOOR_BOT - doorH);
  return { WALL_TOP, WALL_BOT, FLOOR_BOT, doorX, doorY, doorW, doorH };
}

function makeDoor(
  base: ThemeDef,
  i: number,
  isLast: boolean,
  layout: RoomLayout,
  description: string,
): RoomObject {
  const doorBase =
    base.doorPrompts[i] ?? base.doorPrompts[base.doorPrompts.length - 1] ?? "heavy door";
  const doorPrompt = isLast
    ? `${doorBase}, large heavy ornate exit door with glowing edges, ${OBJ_STYLE}`
    : `${doorBase}, closed, ${OBJ_STYLE}`;
  const dr = pxRect(layout.doorX, layout.doorY, layout.doorW, layout.doorH);
  return {
    id: `room${i}_door`,
    name: "door",
    prompt: doorPrompt,
    x: dr.x,
    y: dr.y,
    width: dr.width,
    height: dr.height,
    collidable: true,
    interactable: true,
    removeBackground: true,
    kind: isLast ? "exit" : "door",
    requires: `door_room${i}_unlocked`,
    description,
  };
}

function makeWallDeco(base: ThemeDef, i: number, layout: RoomLayout): RoomObject {
  const n = base.decoStyles.length;
  const idx = n > 0 ? i % n : 0;
  const style = n > 0 ? base.decoStyles[idx]! : "small ambient prop";
  const r = pxRect(22, layout.WALL_BOT - 132, 94, 132);
  return {
    id: `room${i}_deco_wall`,
    name: "deco_wall",
    prompt: `${style}, ${OBJ_STYLE}`,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    collidable: false,
    interactable: false,
    removeBackground: true,
    kind: "decoration",
  };
}

type ChainKind = 0 | 1 | 2;

interface StageSlots {
  noteAR: ReturnType<typeof pxRect>;
  switchR: ReturnType<typeof pxRect>;
  hammerR: ReturnType<typeof pxRect>;
  crowbarR: ReturnType<typeof pxRect>;
  glassR: ReturnType<typeof pxRect>;
  briefR: ReturnType<typeof pxRect>;
  crateR: ReturnType<typeof pxRect>;
  sdR: ReturnType<typeof pxRect>;
  ventR: ReturnType<typeof pxRect>;
  noteBR: ReturnType<typeof pxRect>;
  keyR: ReturnType<typeof pxRect>;
  lockR: ReturnType<typeof pxRect>;
}

/**
 * Stage geometry: props sit in believable bands (wall mid vs floor front),
 * left-to-right read order, clear of the door column on the right.
 */
function buildStageSlots(layout: RoomLayout, jx: number, jy: number): StageSlots {
  const wallMid = Math.round(layout.WALL_TOP + 110 + jy);
  const floorY = (h: number) => Math.round(layout.FLOOR_BOT - h - 6 + jy);

  const noteAR = pxRect(172 + jx, floorY(52), 62, 52);
  const switchR = pxRect(98 + jx, wallMid - 61, 74, 122);
  const hammerR = pxRect(312 + jx, floorY(62), 104, 62);
  const crowbarR = pxRect(132 + jx, floorY(46), 96, 46);
  const glassR = pxRect(448 + jx, wallMid - 82, 176, 164);
  const briefR = pxRect(372 + jx, floorY(74), 140, 74);
  const crateR = pxRect(408 + jx, floorY(80), 140, 80);
  const sdR = pxRect(492 + jx, floorY(50), 92, 50);
  const ventR = pxRect(642 + jx, wallMid - 66, 156, 132);
  const noteBR = pxRect(642 + jx, floorY(50), 64, 50);
  const keyR = pxRect(756 + jx, floorY(52), 84, 52);
  const lockR = pxRect(layout.doorX - 68 + jx, layout.doorY + 118, 64, 112);
  return {
    noteAR,
    switchR,
    hammerR,
    crowbarR,
    glassR,
    briefR,
    crateR,
    sdR,
    ventR,
    noteBR,
    keyR,
    lockR,
  };
}

/**
 * One room = 8-step tool chain. `chainKind` (from global seed) picks a
 * different *mechanical story* so runs do not feel copy-pasted.
 */
function buildToolChainRoom(
  rng: () => number,
  base: ThemeDef,
  i: number,
  numRooms: number,
  globalSeed: number,
): RoomPlan {
  const isLast = i === numRooms - 1;
  const isFirst = i === 0;
  const roomId = `room${i}`;
  const layout = makeLayout();

  const chainKind = ((globalSeed >>> 0) + i * 92837111) % 3 as ChainKind;
  const jx = spread(i, chainKind, 1, 10);
  const jy = spread(i, chainKind, 2, 6);
  const S = buildStageSlots(layout, jx, jy);

  const hammerId = `hammer_r${i}`;
  const crowbarId = `crowbar_r${i}`;
  const screwdriverId = `screwdriver_r${i}`;
  const keyId = `key_r${i}`;
  const noteAId = `noteA_r${i}`;
  const noteBId = `noteB_r${i}`;

  const fClueA = `r${i}_clue_a`;
  const fPower = `r${i}_power`;
  const fHammerUp = `r${i}_hammer_up`;
  const fCrowUp = `r${i}_crow_up`;
  const fGlass = `r${i}_glass_broken`;
  const fCrate = `r${i}_crate_open`;
  const fSd = `r${i}_sd_up`;
  const fVent = `r${i}_vent_open`;
  const fCode = `r${i}_code_known`;
  const fKey = `r${i}_key_up`;
  const doorFlag = `door_${roomId}_unlocked`;

  const code = String(randInt(rng, 1000, 9999));
  const WORDS = ["MOON", "STAR", "NOVA", "WARP", "LOCK", "RUNE", "DUSK", "SILK"];
  const letterCode = WORDS[randInt(rng, 0, WORDS.length - 1)]!;

  const objects: RoomObject[] = [];

  const noteBodiesA: Record<ChainKind, string> = {
    0: "The wall switch is dead until you acknowledge this scrap. Read it, then throw the breaker — the room wakes in layers.",
    1: "Someone rewired the master breaker to ignore strangers. Acknowledge this note first — then the switch will accept you.",
    2: "Power is out. The breaker won't listen until you've read this. After that, pry open whatever is nailed shut.",
  };
  const switchDesc: Record<ChainKind, string> = {
    0: "Master breaker. Snap it on and the floor lights pick out what was hiding in the dark.",
    1: "Primary disconnect — only responds after you've read the warning note on the floor.",
    2: "Main power lever. Once it's live, look for cargo that was never meant to stay closed.",
  };

  // -------- STEP 1: Note A --------
  objects.push({
    id: `${roomId}_step1_noteA`,
    name: "noteA",
    prompt: `${base.noteAPrompt}, ${OBJ_STYLE}`,
    x: S.noteAR.x,
    y: S.noteAR.y,
    width: S.noteAR.width,
    height: S.noteAR.height,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "clue_note",
    gives: fClueA,
    itemId: noteAId,
    itemDisplayName: "Floor note",
    itemEmoji: "📝",
    noteTitle: chainKind === 1 ? "Warning tag" : chainKind === 2 ? "Shipping memo" : "Scrap note",
    noteBody: noteBodiesA[chainKind],
    description: "Something worth reading lies on the floorboards.",
  });

  // -------- STEP 2: Switch --------
  objects.push({
    id: `${roomId}_step2_switch`,
    name: "switch",
    prompt: `${base.switchPrompt}, ${OBJ_STYLE}`,
    x: S.switchR.x,
    y: S.switchR.y,
    width: S.switchR.width,
    height: S.switchR.height,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "switch",
    initialOn: chainKind === 1,
    targetOn: chainKind !== 1,
    requires: fClueA,
    gives: fPower,
    description: switchDesc[chainKind],
  });

  // -------- STEP 3: First tool (hammer or crowbar) --------
  if (chainKind === 2) {
    objects.push({
      id: `${roomId}_step3_crowbar`,
      name: "crowbar",
      prompt: `${base.crowbarPrompt}, ${OBJ_STYLE}`,
      x: S.crowbarR.x,
      y: S.crowbarR.y,
      width: S.crowbarR.width,
      height: S.crowbarR.height,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "tool_item",
      hiddenUntilFlag: fPower,
      gives: fCrowUp,
      itemId: crowbarId,
      itemDisplayName: "Crowbar",
      itemEmoji: "🛠️",
      toolKind: "crowbar",
      description: "A pry bar — looks perfect for splintering cheap wood.",
    });
  } else {
    objects.push({
      id: `${roomId}_step3_hammer`,
      name: "hammer",
      prompt: `${base.hammerPrompt}, ${OBJ_STYLE}`,
      x: S.hammerR.x,
      y: S.hammerR.y,
      width: S.hammerR.width,
      height: S.hammerR.height,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "tool_item",
      hiddenUntilFlag: fPower,
      gives: fHammerUp,
      itemId: hammerId,
      itemDisplayName: "Hammer",
      itemEmoji: "🔨",
      toolKind: "hammer",
      description: "Heavy enough to shatter whatever is pretending to be display glass.",
    });
  }

  // -------- STEP 4: First breakable (glass case OR wooden crate) --------
  if (chainKind === 2) {
    objects.push({
      id: `${roomId}_step4_crate`,
      name: "crate",
      prompt: `${base.cratePrompt}, ${OBJ_STYLE}`,
      x: S.crateR.x,
      y: S.crateR.y,
      width: S.crateR.width,
      height: S.crateR.height,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "breakable",
      needsToolKind: "crowbar",
      gives: fCrate,
      description: "A nailed crate. Whatever is inside rattles when you kick it.",
    });
  } else {
    objects.push({
      id: `${roomId}_step4_glasscase`,
      name: "glass_case",
      prompt: `${base.glassCasePrompt}, ${OBJ_STYLE}`,
      x: S.glassR.x,
      y: S.glassR.y,
      width: S.glassR.width,
      height: S.glassR.height,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "breakable",
      needsToolKind: "hammer",
      gives: fGlass,
      description: "A reinforced display case. Something glints behind the glass.",
    });
  }

  // -------- STEP 5: Screwdriver (hidden until first container opens) --------
  objects.push({
    id: `${roomId}_step5_screwdriver`,
    name: "screwdriver",
    prompt: `${base.screwdriverPrompt}, ${OBJ_STYLE}`,
    x: S.sdR.x,
    y: S.sdR.y,
    width: S.sdR.width,
    height: S.sdR.height,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "tool_item",
    hiddenUntilFlag: chainKind === 2 ? fCrate : fGlass,
    gives: fSd,
    itemId: screwdriverId,
    itemDisplayName: "Screwdriver",
    itemEmoji: "🪛",
    toolKind: "screwdriver",
    description: "Precision driver — the vent screws look exactly its size.",
  });

  // -------- STEP 6: Second breakable (vent OR briefcase) --------
  if (chainKind === 1) {
    objects.push({
      id: `${roomId}_step6_briefcase`,
      name: "briefcase",
      prompt: `${base.briefcasePrompt}, ${OBJ_STYLE}`,
      x: S.briefR.x,
      y: S.briefR.y,
      width: S.briefR.width,
      height: S.briefR.height,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "breakable",
      needsToolKind: "screwdriver",
      gives: fVent,
      description: "A travel case with tiny torque screws — ridiculous, but it's sealed.",
    });
  } else {
    objects.push({
      id: `${roomId}_step6_vent`,
      name: "vent",
      prompt: `${base.ventPrompt}, ${OBJ_STYLE}`,
      x: S.ventR.x,
      y: S.ventR.y,
      width: S.ventR.width,
      height: S.ventR.height,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "breakable",
      needsToolKind: "screwdriver",
      gives: fVent,
      description: "A wall vent — whoever hid the exit route loved sheet metal.",
    });
  }

  const noteBBodyClassic = isLast
    ? `Final seal — four letters:\n\n    ${letterCode}\n\nSlot the key, then dial the word.`
    : `Door keypad — four digits:\n\n    ${code}\n\nUse the key first, then punch the code.`;
  const noteBBodyInverted = isLast
    ? `Letters for the exit dial:\n\n    ${letterCode}\n\nThey only glow once the case is cracked.`
    : `Numeric override:\n\n    ${code}\n\nThe keypad stays blind until the case is cracked.`;
  const noteBBodyCrate = isLast
    ? `Rune word for the last lock:\n\n    ${letterCode}\n\nKey first, then the word.`
    : `Access code after the crate split:\n\n    ${code}\n\nKey first, then the digits.`;

  // -------- STEP 7a: Coded note --------
  objects.push({
    id: `${roomId}_step7_noteB`,
    name: "noteB",
    prompt: `${base.noteBPrompt}, ${OBJ_STYLE}`,
    x: S.noteBR.x,
    y: S.noteBR.y,
    width: S.noteBR.width,
    height: S.noteBR.height,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "clue_note",
    hiddenUntilFlag: fVent,
    gives: fCode,
    itemId: noteBId,
    itemDisplayName: "Coded slip",
    itemEmoji: "📜",
    noteTitle: chainKind === 1 ? "Case lining" : chainKind === 2 ? "Packing slip" : "Cipher scrap",
    noteBody: chainKind === 1 ? noteBBodyInverted : chainKind === 2 ? noteBBodyCrate : noteBBodyClassic,
    description: "Whatever was hidden behind the last barrier left instructions.",
  });

  // -------- STEP 7b: Key --------
  objects.push({
    id: `${roomId}_step7_key`,
    name: "key",
    prompt: `${base.keyPrompt}, ${OBJ_STYLE}`,
    x: S.keyR.x,
    y: S.keyR.y,
    width: S.keyR.width,
    height: S.keyR.height,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "tool_item",
    hiddenUntilFlag: fVent,
    gives: fKey,
    itemId: keyId,
    itemDisplayName: isLast ? "Exit key" : "Transit key",
    itemEmoji: "🗝️",
    toolKind: "key",
    description: "Cold metal — the door's sister lock was built for this bow.",
  });

  // -------- STEP 8: Lock panel --------
  objects.push({
    id: `${roomId}_step8_doorlock`,
    name: "doorlock",
    prompt: `small wall-mounted heavy ornate lock panel beside the door, ${OBJ_STYLE}`,
    x: S.lockR.x,
    y: S.lockR.y,
    width: S.lockR.width,
    height: S.lockR.height,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: isLast ? "letter_lock" : "keypad",
    codeAnswer: isLast ? letterCode : code,
    codeLength: 4,
    isLetters: isLast,
    needsKeyItemId: keyId,
    requires: fCode,
    gives: doorFlag,
    description: isLast
      ? "Letter dial beside the exit — needs the key and the word."
      : "Numeric pad beside the bulkhead — needs the key and the digits.",
  });

  objects.push(
    makeDoor(
      base,
      i,
      isLast,
      layout,
      isLast
        ? "The final exit door. Solve every puzzle in this room to open it."
        : "The door to the next room. Locked until the puzzle is finished.",
    ),
  );

  objects.push(makeWallDeco(base, i, layout));

  const baseIntro = isFirst
    ? `You wake up in the ${base.rooms[i]}. The door behind you is sealed.`
    : isLast
      ? `You enter the final room: the ${base.rooms[i]}. Freedom is close.`
      : `You step into the ${base.rooms[i]}. The deeper you go, the stranger it gets.`;

  const chainLabels: Record<ChainKind, string> = {
    0: "Classic lab chain: note → breaker → hammer → glass → driver → vent → cipher → key → lock.",
    1: "Inverted power chain: note → flip breaker OFF → hammer → glass → driver → locked case → stash → key → lock.",
    2: "Cargo bay chain: note → power → crowbar → nailed crate → driver → vent → stash → key → lock.",
  };

  const chainIntro = [
    `Room script ${chainKind + 1}/3 (seed ${globalSeed >>> 0}):`,
    chainLabels[chainKind],
    "Equip tools from the Items bar, click matching props, then finish on the door lock.",
  ].join("\n");

  return {
    id: roomId,
    name: base.rooms[i] ?? `Room ${i + 1}`,
    background_prompt: base.bgs[i] ?? base.bgs[0]!,
    ambient_color: base.ambient[i] ?? "#0a0a14",
    objects,
    intro: `${baseIntro}\n\n${chainIntro}`,
  };
}
