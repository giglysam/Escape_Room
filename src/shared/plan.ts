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
  /** Prompt for the hammer cutout. */
  hammerPrompt: string;
  /** Prompt for the screwdriver cutout. */
  screwdriverPrompt: string;
  /** Prompt for the knife cutout (unused in baseline, reserved). */
  knifePrompt: string;
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
    hammerPrompt: "small heavy rubber grip claw hammer",
    screwdriverPrompt: "small phillips head screwdriver with a yellow handle",
    knifePrompt: "small utility knife with a retractable blade",
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
    hammerPrompt: "small antique iron blacksmith hammer with a worn wooden handle",
    screwdriverPrompt: "small antique brass flathead screwdriver with a wooden handle",
    knifePrompt: "small ornate ottoman letter opener with an engraved blade",
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
    hammerPrompt: "small emergency rubber mallet with a yellow handle",
    screwdriverPrompt: "small hex screwdriver with a black grip",
    knifePrompt: "small utility blade with a stainless steel sheath",
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
    hammerPrompt: "small blacksmith iron hammer with a wooden handle",
    screwdriverPrompt: "small antique iron flathead screwdriver with a wooden handle",
    knifePrompt: "small ornate ritual silver athame knife with a carved handle",
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
    hammerPrompt: `small hammer whose materials and handle come from the world of ${t}`,
    screwdriverPrompt: `small screwdriver whose materials come from the world of ${t}`,
    knifePrompt: `small hand knife whose materials come from the world of ${t}`,
    keyPrompt: `small ornate key whose shape and material are unmistakably ${t}`,
  };
}

export const PLAN_CANVAS = { width: W, height: H, floorTop: FLOOR_TOP };

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
    const room = buildToolChainRoom(rng, base, i, numRooms);
    room.background_prompt = composeBackgroundPrompt(base, i);
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

function composeBackgroundPrompt(base: ThemeDef, i: number): string {
  const sceneBase = base.bgs[i] ?? base.bgs[0]!;
  const forbidden = [
    "completely empty room",
    "no door",
    "no doors",
    "no doorway",
    "no keypad",
    "no panel",
    "no buttons",
    "no switches",
    "no levers",
    "no console",
    "no terminal",
    "no machinery",
    "no furniture",
    "no chest",
    "no pedestal",
    "no altar",
    "no statue",
    "no shelf",
    "no table",
    "no chair",
    "no rug",
    "no scroll",
    "no paper",
    "no note",
    "no people",
    "no creatures",
    "no text",
    "no logos",
  ].join(", ");

  return [
    sceneBase,
    "completely empty atmospheric room interior, only the back wall and the floor are visible",
    "no objects of any kind, no furniture, no doors, no windows, no props",
    "rich theme-driven wall textures and floor textures, deep ambient lighting, painterly atmosphere, immersive mood",
    `straight-on 2D side-scrolling camera, ${W}x${H} pixels, back wall fills the upper half, floor fills the lower half`,
    forbidden,
  ].join(", ");
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
  const doorX = W - doorW - 80;
  const doorY = FLOOR_BOT - doorH;
  return { WALL_TOP, WALL_BOT, FLOOR_BOT, doorX, doorY, doorW, doorH };
}

/** Y-coordinate for a prop on a themed anchor band. */
function anchorY(
  layout: RoomLayout,
  anchor: "wall_top" | "wall_mid" | "floor_back" | "floor_front",
  h: number,
): number {
  switch (anchor) {
    case "wall_top":
      return layout.WALL_TOP + 20;
    case "wall_mid":
      return layout.WALL_TOP + 110;
    case "floor_back":
      return layout.FLOOR_BOT - h - 24;
    case "floor_front":
      return layout.FLOOR_BOT - h - 4;
  }
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
  return {
    id: `room${i}_door`,
    name: "door",
    prompt: doorPrompt,
    x: layout.doorX,
    y: layout.doorY,
    width: layout.doorW,
    height: layout.doorH,
    collidable: true,
    interactable: true,
    removeBackground: true,
    kind: isLast ? "exit" : "door",
    requires: `door_room${i}_unlocked`,
    description,
  };
}

function makeWallDeco(
  base: ThemeDef,
  rng: () => number,
  i: number,
  layout: RoomLayout,
): RoomObject {
  const idx = randInt(rng, 0, base.decoStyles.length - 1);
  return {
    id: `room${i}_deco_wall`,
    name: "deco_wall",
    prompt: `${base.decoStyles[idx]}, ${OBJ_STYLE}`,
    x: randInt(rng, 20, 60),
    y: layout.WALL_BOT - 130,
    width: 96,
    height: 130,
    collidable: false,
    interactable: false,
    removeBackground: true,
    kind: "decoration",
  };
}

/**
 * Builds one "room" as a chain of 8 tool-based puzzles:
 *
 *   1. Clue note on the floor                     → flag `r_clue_a`
 *   2. Wall switch                                → flag `r_power`
 *   3. Hammer on the floor                        → item `hammer_ri`
 *   4. Glass display case on the wall (hammer)    → flag `r_glass`
 *   5. Screwdriver inside the case                → item `sd_ri`
 *   6. Wall vent (screwdriver)                    → flag `r_vent`
 *   7. Second note inside vent (door code)        → flag `r_code_known`
 *      Brass key inside vent                      → item `key_ri`
 *   8. Door (needs key + keypad code)             → flag `door_roomi_unlocked`
 *
 * All ids/flags are scoped per room (`r0_*`, `r1_*`, …) so flags and
 * items from earlier rooms don't leak into later ones.
 */
function buildToolChainRoom(
  rng: () => number,
  base: ThemeDef,
  i: number,
  numRooms: number,
): RoomPlan {
  const isLast = i === numRooms - 1;
  const isFirst = i === 0;
  const roomId = `room${i}`;
  const layout = makeLayout();

  // Per-room scoped item ids (engine uses these as inventory keys)
  const hammerId = `hammer_r${i}`;
  const screwdriverId = `screwdriver_r${i}`;
  const keyId = `key_r${i}`;
  const noteAId = `noteA_r${i}`;
  const noteBId = `noteB_r${i}`;

  // Per-room scoped flags
  const fClueA = `r${i}_clue_a`;
  const fPower = `r${i}_power`;
  const fHammerUp = `r${i}_hammer_up`;
  const fGlass = `r${i}_glass_broken`;
  const fSd = `r${i}_sd_up`;
  const fVent = `r${i}_vent_open`;
  const fCode = `r${i}_code_known`;
  const fKey = `r${i}_key_up`;
  const doorFlag = `door_${roomId}_unlocked`;

  // Pick a 4-digit code unique per room so the same run uses the same
  // code for the same seed.
  const code = String(randInt(rng, 1000, 9999));

  // Pick a 4-letter code for the last room's letter lock variant.
  const WORDS = ["MOON", "STAR", "NOVA", "WARP", "LOCK", "RUNE", "DUSK", "SILK"];
  const letterCode = WORDS[randInt(rng, 0, WORDS.length - 1)]!;

  const objects: RoomObject[] = [];

  // -------- STEP 1: Note A on the floor (always visible) --------
  objects.push({
    id: `${roomId}_step1_noteA`,
    name: "noteA",
    prompt: `${base.noteAPrompt}, ${OBJ_STYLE}`,
    x: 180,
    y: anchorY(layout, "floor_front", 50),
    width: 60,
    height: 50,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "clue_note",
    gives: fClueA,
    itemId: noteAId,
    itemDisplayName: "Crumpled Note",
    itemEmoji: "📝",
    noteTitle: "Crumpled Note",
    noteBody:
      "Behind me the wall switch has been disarmed. Flip it to bring the lights back — everything else in this room is dark until then.",
    description: "A crumpled piece of paper on the floor.",
  });

  // -------- STEP 2: Wall switch (requires clue A) --------
  objects.push({
    id: `${roomId}_step2_switch`,
    name: "switch",
    prompt: `${base.switchPrompt}, ${OBJ_STYLE}`,
    x: 100,
    y: anchorY(layout, "wall_mid", 120),
    width: 70,
    height: 120,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "switch",
    initialOn: false,
    targetOn: true,
    requires: fClueA,
    gives: fPower,
    description: "A heavy wall switch. Pulling it should restore power.",
  });

  // -------- STEP 3: Hammer on the floor (hidden until power) --------
  objects.push({
    id: `${roomId}_step3_hammer`,
    name: "hammer",
    prompt: `${base.hammerPrompt}, ${OBJ_STYLE}`,
    x: 330,
    y: anchorY(layout, "floor_front", 60),
    width: 100,
    height: 60,
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
    description: "A sturdy hammer. Good for smashing glass.",
  });

  // -------- STEP 4: Glass display case on the wall (needs hammer) --------
  objects.push({
    id: `${roomId}_step4_glasscase`,
    name: "glass_case",
    prompt: `${base.glassCasePrompt}, ${OBJ_STYLE}`,
    x: 470,
    y: anchorY(layout, "wall_mid", 160),
    width: 170,
    height: 160,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "breakable",
    needsToolKind: "hammer",
    gives: fGlass,
    description: "A reinforced glass case. Something is sealed inside.",
  });

  // -------- STEP 5: Screwdriver (hidden inside the case) --------
  objects.push({
    id: `${roomId}_step5_screwdriver`,
    name: "screwdriver",
    prompt: `${base.screwdriverPrompt}, ${OBJ_STYLE}`,
    x: 510,
    y: anchorY(layout, "floor_front", 50),
    width: 90,
    height: 48,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "tool_item",
    hiddenUntilFlag: fGlass,
    gives: fSd,
    itemId: screwdriverId,
    itemDisplayName: "Screwdriver",
    itemEmoji: "🪛",
    toolKind: "screwdriver",
    description: "A screwdriver. Good for unscrewing grates.",
  });

  // -------- STEP 6: Wall vent (needs screwdriver) --------
  objects.push({
    id: `${roomId}_step6_vent`,
    name: "vent",
    prompt: `${base.ventPrompt}, ${OBJ_STYLE}`,
    x: 710,
    y: anchorY(layout, "wall_mid", 130),
    width: 150,
    height: 130,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "breakable",
    needsToolKind: "screwdriver",
    gives: fVent,
    description: "An air vent bolted to the wall with four screws.",
  });

  // -------- STEP 7a: Note B with door code (hidden in vent) --------
  objects.push({
    id: `${roomId}_step7_noteB`,
    name: "noteB",
    prompt: `${base.noteBPrompt}, ${OBJ_STYLE}`,
    x: 660,
    y: anchorY(layout, "floor_front", 48),
    width: 60,
    height: 48,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "clue_note",
    hiddenUntilFlag: fVent,
    gives: fCode,
    itemId: noteBId,
    itemDisplayName: "Coded Note",
    itemEmoji: "📜",
    noteTitle: "Coded Note",
    noteBody: isLast
      ? `The final door accepts a four-letter word:\n\n    ${letterCode}\n\nThe brass key fits the lock. Insert it, then enter the word.`
      : `Door keypad code:\n\n    ${code}\n\nThe brass key fits the lock. Insert it, then enter the code.`,
    description: "A folded note hidden behind the vent.",
  });

  // -------- STEP 7b: Brass key (hidden in vent) --------
  objects.push({
    id: `${roomId}_step7_key`,
    name: "key",
    prompt: `${base.keyPrompt}, ${OBJ_STYLE}`,
    x: 780,
    y: anchorY(layout, "floor_front", 50),
    width: 80,
    height: 50,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "tool_item",
    hiddenUntilFlag: fVent,
    gives: fKey,
    itemId: keyId,
    itemDisplayName: isLast ? "Rune Key" : "Brass Key",
    itemEmoji: "🗝️",
    toolKind: "key",
    description: "A heavy key. It must fit the exit door.",
  });

  // -------- STEP 8: Door lock (key + keypad / letter lock) --------
  // We model the final puzzle as a single `keyed_lock` drawn on the
  // door frame: clicking it with the key in the inventory opens a
  // code modal, and a correct answer sets the door flag.
  objects.push({
    id: `${roomId}_step8_doorlock`,
    name: "doorlock",
    prompt: `small wall-mounted heavy ornate lock panel beside the door, ${OBJ_STYLE}`,
    x: layout.doorX - 70,
    y: layout.doorY + 120,
    width: 60,
    height: 110,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: isLast ? "letter_lock" : "keypad",
    codeAnswer: isLast ? letterCode : code,
    codeLength: 4,
    isLetters: isLast,
    needsKeyItemId: keyId,
    requires: fCode, // must know the code before the lock reveals itself
    gives: doorFlag,
    description: isLast
      ? "An engraved four-letter dial lock beside the door."
      : "A four-digit keypad beside the door.",
  });

  // -------- DOOR (becomes interactive once door flag is set) --------
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

  // -------- WALL DECO (purely atmospheric) --------
  objects.push(makeWallDeco(base, rng, i, layout));

  const baseIntro = isFirst
    ? `You wake up in the ${base.rooms[i]}. The door behind you is sealed.`
    : isLast
      ? `You enter the final room: the ${base.rooms[i]}. Freedom is close.`
      : `You step into the ${base.rooms[i]}. The deeper you go, the stranger it gets.`;

  const chainIntro = [
    "Eight puzzles stand between you and the next door:",
    "  • Read the notes",
    "  • Power the room with the wall switch",
    "  • Pick up the hammer and smash the glass case",
    "  • Use the screwdriver to pry open the vent",
    "  • Grab the key, read the code, unlock the door.",
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
