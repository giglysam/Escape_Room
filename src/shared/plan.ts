/**
 * Procedural escape-room plan generator.
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

export type ObjectKind =
  | "door"
  | "exit"
  | "decoration"
  // Archetype A — Collect & Combine
  | "item"
  | "pedestal"
  // Archetype B — Symbol Sequence
  | "sequence_clue"
  | "sequence_button"
  // Archetype C — Logic Switches
  | "switch"
  | "switch_clue";

export type PuzzleArchetype = "collect" | "sequence" | "switches";

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
  /** Items needed to interact (e.g. a door waiting for a key flag). */
  requires?: string;
  /** Item id given to the player on use (collected items). */
  gives?: string;
  /** Description shown in info popup. */
  description?: string;
  /** Hint shown after a wrong attempt. */
  hint?: string;

  // ---- Archetype-specific data ----

  /** sequence_clue / sequence_button / switch_clue / pedestal — the symbol shown. */
  symbol?: string;
  /** sequence_button: which slot in the sequence this button represents (0..n). */
  symbolIndex?: number;
  /** switch: 0/1 = currently on/off (initial state). */
  initialOn?: boolean;
  /** switch: must this switch be ON in the target pattern? */
  targetOn?: boolean;
  /** pedestal: list of item ids that must be deposited (any order). */
  acceptsItems?: string[];
  /** sequence_clue: the full ordered list of symbols. */
  sequenceSymbols?: string[];
  /** Which puzzle archetype this object belongs to. */
  puzzle?: PuzzleArchetype;
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
  /**
   * Section 1 of the blueprint — Core Concept & Narrative.
   * These fields are used by the briefing screen, the persistent objective
   * banner, and the timeout / lose-state messaging.
   */
  mission: string;
  hook: string;
  stakes: string;
  /** Total seconds available to escape across all rooms. */
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

/** Unicode glyphs we use for the on-screen symbol sequence puzzle. They are
 * deliberately abstract so they read as "ancient runes / glyphs / sigils"
 * regardless of theme. */
const SYMBOL_POOL = ["✦", "✧", "✪", "✺", "❖", "✷", "✶", "❂", "☥", "✹"];

interface ThemeDef {
  title: string;
  story: string;
  /** Mission / Hook / Stakes per the blueprint section 1. */
  mission: string;
  hook: string;
  stakes: string;
  /** Background prompts per room (full scene including environment). */
  bgs: string[];
  /** Display name per room. */
  rooms: string[];
  ambient: string[];
  /** Prompt fragment for the door object (per room). */
  doorPrompts: string[];
  /** Pool of small thematic decoration objects (never buildings). */
  decoStyles: string[];
  // ---- Archetype-specific theme prompts ----
  /** A — Collect & Combine: 3 thematic items + the pedestal/altar that accepts them. */
  itemPrompts: string[];
  pedestalPrompt: string;
  /** B — Sequence: a wall mural showing symbols, plus a generic button look. */
  muralPrompt: string;
  buttonPrompt: string;
  /** C — Switches: a wall switch and the deco object whose surface holds the clue. */
  switchPrompt: string;
  cluePropPrompt: string;
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
    stakes: "If you fail, the core breaches and the entire research wing — and you with it — is reduced to slag.",
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
      "lab beaker with glowing liquid",
      "discarded VR headset",
    ],
    itemPrompts: [
      "small glowing blue power core cell, sci-fi",
      "small fingerprint authentication chip, sci-fi",
      "small holographic memory crystal, sci-fi",
    ],
    pedestalPrompt:
      "futuristic metallic console pedestal with three empty circular slots glowing blue, sci-fi",
    muralPrompt:
      "futuristic wall display screen showing a glowing sequence of four ancient symbols, sci-fi",
    buttonPrompt: "small futuristic backlit hexagonal symbol button with glowing edges, sci-fi",
    switchPrompt:
      "industrial wall mounted heavy duty toggle switch with red and green indicator light, sci-fi",
    cluePropPrompt:
      "small futuristic data tablet displaying a wiring diagram of switches, sci-fi",
  },
  {
    title: "Beirut Antiquarian Heist",
    story:
      "You're locked in a forgotten antique shop in old Beirut. Lebanese mosaics hide ancient mechanisms. Crack them before dawn or be sealed in forever.",
    mission: "Reach the rooftop courtyard before the call to dawn prayer.",
    hook: "The collector who hired you vanished an hour ago. The shop's door bolted itself the moment you stepped inside, and the mosaics on the walls have started glowing.",
    stakes: "At first light the building's ancient lock-stones fuse permanently — you stay buried with the artifacts forever.",
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
      "small persian carpet rolled up",
      "engraved silver tray",
    ],
    itemPrompts: [
      "small ornate brass key with arabic engraving, antique",
      "small phoenician bronze coin with engraved markings, antique",
      "small carved cedar wood amulet, antique",
    ],
    pedestalPrompt:
      "ornate stone altar pedestal with three empty engraved indentations on top, antique middle eastern style",
    muralPrompt:
      "ancient stone wall mural with a row of four carved phoenician symbols glowing softly, antique",
    buttonPrompt: "small carved brass button with a single engraved phoenician symbol, antique",
    switchPrompt:
      "antique brass wall lever with two positions and an engraved indicator, ornate ottoman style",
    cluePropPrompt:
      "old yellowed parchment scroll showing a row of four levers with some highlighted, antique ink drawing",
  },
  {
    title: "Derelict Starship Sigma",
    story:
      "Cryo-sleep failed. The starship Sigma is silent and the airlock is sealed. Reroute power, override the captain's lock, reach the escape pod.",
    mission: "Reach Escape Pod Bay 3 before life support runs out.",
    hook: "Your cryo-pod popped open hours after the rest of the crew vanished. Comms are dead. The ship is drifting toward a star, and atmospheric pressure is dropping by the minute.",
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
      "small portable oxygen tank",
      "discarded clipboard with technical schematics",
    ],
    itemPrompts: [
      "small spaceship plasma fuse cylinder, sci-fi",
      "small captain access keycard, sci-fi",
      "small spaceship coolant capsule, sci-fi",
    ],
    pedestalPrompt:
      "spaceship engineering console pedestal with three empty receptacle slots, sci-fi",
    muralPrompt:
      "spaceship wall display screen showing a glowing sequence of four navigation symbols, sci-fi",
    buttonPrompt: "small spaceship console button with a single glowing symbol, sci-fi",
    switchPrompt:
      "spaceship wall mounted breaker switch with status LED, industrial sci-fi",
    cluePropPrompt:
      "small data tablet displaying a circuit breaker diagram with some breakers highlighted, sci-fi",
  },
  {
    title: "Witch's Mountain Cabin",
    story:
      "You sheltered from a storm in a cabin that locked behind you. Old runes and bubbling potions hint at a way out — if you can read them in time.",
    mission: "Reach the forest gate before the witch returns from her hunt.",
    hook: "The storm chased you into a cabin you didn't choose. The door slammed itself shut and the candles lit themselves the moment you crossed the threshold.",
    stakes: "When the witch comes home she'll add you to her shelf of curiosities — labelled and preserved.",
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
      "wooden cauldron with smoke",
      "skull candle holder",
    ],
    itemPrompts: [
      "small glowing red potion vial with a cork stopper",
      "small carved bone rune talisman",
      "small dried herb bundle tied with twine",
    ],
    pedestalPrompt:
      "old wooden ritual pedestal with three empty engraved circles on top, mystical witch style",
    muralPrompt:
      "old wooden plank wall with four glowing carved runes in a row, mystical",
    buttonPrompt: "small carved wooden button with a single glowing rune, mystical",
    switchPrompt:
      "old iron wall lever with a glowing rune indicator, mystical witch style",
    cluePropPrompt:
      "old torn parchment showing a row of four levers with some highlighted, witch ink drawing",
  },
];

/**
 * Build a ThemeDef on the fly from a freeform user theme. The whole story,
 * backgrounds, props and decor are phrased in terms of the theme — never
 * hard-coded as a "lab" or "cabin".
 */
/**
 * Builds a deeply theme-driven `ThemeDef` from a freeform user phrase.
 *
 * The goal is total immersion — every prompt is phrased so the model
 * treats `{theme}` as the *entire world* the player is inside, not just a
 * decorative motif. Per-room sub-locations create a sense of journey
 * (entrance → heart → exit), every prop wears the theme's vocabulary,
 * and the background prompts are atmospheric-only (no doors, no props).
 */
function buildCustomTheme(theme: string): ThemeDef {
  const t = theme.trim();

  // A reusable "vibe pack" we can sprinkle into prompts to amplify
  // immersion. The model picks up multi-sensory cues much better when
  // we mention textures, materials, smells, and lighting.
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
      `atmospheric depth, painterly background art, cinematic concept art quality`,
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

    // Backgrounds describe ONLY the empty themed environment. No doors,
    // no furniture, no props. Cutouts will be placed on top.
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
      `small ambient light source styled in the visual language of ${t}`,
      `small atmospheric prop made from materials specific to ${t}`,
    ],
    itemPrompts: [
      `small ritual offering number one, made entirely from materials and motifs of ${t}, instantly recognizable as ${t}`,
      `small ritual offering number two, made entirely from materials and motifs of ${t}, instantly recognizable as ${t}`,
      `small ritual offering number three, made entirely from materials and motifs of ${t}, instantly recognizable as ${t}`,
      `small ritual offering number four, made entirely from materials and motifs of ${t}, instantly recognizable as ${t}`,
      `small ritual offering number five, made entirely from materials and motifs of ${t}, instantly recognizable as ${t}`,
    ],
    pedestalPrompt: `ornate pedestal or altar with empty receptacles on top, the entire pedestal is sculpted from materials and motifs of ${t}, every detail unmistakably ${t}`,
    muralPrompt: `wall plaque showing a sequence of glowing symbols, the plaque material and the symbols themselves are pulled from the visual language of ${t}`,
    buttonPrompt: `small push button with a single glowing symbol, button materials and the symbol art are pulled from the visual language of ${t}`,
    switchPrompt: `wall mounted toggle switch or lever with a status indicator, the switch is sculpted from materials of ${t}, fits the world of ${t}`,
    cluePropPrompt: `small handheld diagram showing several switch positions, the diagram surface and ink/etching style are from ${t}`,
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

export function generateProceduralPlan(req: PlanReq = {}): GamePlan {
  const seed = req.seed ?? Math.floor(Math.random() * 1e9);
  const rng = mulberry32(seed);

  // When the user typed a theme we synthesise a fully theme-driven ThemeDef
  // so backgrounds, doors, keypad, container, note and decor are ALL phrased
  // in terms of their theme — never leak in a default lab/cabin look.
  const base: ThemeDef = req.theme ? buildCustomTheme(req.theme) : pick(rng, THEMES);
  const titleOverride = base.title;

  const numRooms = Math.max(2, Math.min(3, req.rooms ?? 3));

  // Pick a starting archetype, then rotate so every room is mechanically
  // different. With 3 rooms each playthrough hits all three archetypes.
  const ARCHETYPES: PuzzleArchetype[] = ["collect", "sequence", "switches"];
  const startArch = randInt(rng, 0, ARCHETYPES.length - 1);

  const rooms: RoomPlan[] = [];
  for (let i = 0; i < numRooms; i++) {
    const arch = ARCHETYPES[(startArch + i) % ARCHETYPES.length]!;
    const room = buildRoom(rng, base, i, numRooms, arch);
    // Rewrite the room's background prompt so the AI is told EXACTLY where
    // every prop sits — no more "two doors" / "cup on the floor" mismatches.
    room.background_prompt = composeBackgroundPrompt(room, base, i, numRooms);
    rooms.push(room);
  }

  // Difficulty → time budget. Easier runs give more thinking time. The
  // blueprint says easy start, hard middle, adrenaline finish — the timer
  // creates the climax automatically.
  const difficulty = req.difficulty ?? "normal";
  const baseSeconds = difficulty === "easy" ? 540 : difficulty === "hard" ? 300 : 420;

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
// Background-prompt composer — encodes object positions into the
// background prompt so the AI paints them in the right places. The
// in-game cutouts then sit ON TOP of what the AI painted, so the door
// hotspot covers the painted door (no "two doors"), the keypad sits
// over the painted keypad, etc.
// ===============================================================

/**
 * NEW POLICY (no more "two doors" bug):
 *
 * The background image must be a COMPLETELY EMPTY themed environment —
 * no doors, no switches, no keypads, no pedestals, no chests, no notes,
 * no levers, no buttons, no machinery. Every gameplay-meaningful object
 * is generated as a separate transparent cutout and placed on top.
 *
 * The background's only job is atmosphere: a back wall + a floor + the
 * theme's textures, materials, lighting, and mood. The cutout props
 * provide the door, the keypad, etc., so we can place them precisely and
 * the player never sees a "ghost" door painted into the background.
 */

function composeBackgroundPrompt(
  _room: RoomPlan,
  base: ThemeDef,
  i: number,
  _numRooms: number,
): string {
  void _room;
  void _numRooms;

  // Use the theme's prose background as the world flavour, but strip any
  // wording that might cause the model to paint props.
  const sceneBase = base.bgs[i] ?? base.bgs[0]!;

  // Strong, repeated negatives to enforce an empty room. The model
  // weights repeated tokens, so we list the same forbidden category in
  // multiple ways.
  const forbidden = [
    "completely empty room",
    "no door",
    "no doors",
    "no doorway",
    "no entrance",
    "no exit",
    "no gate",
    "no portal",
    "no window",
    "no opening",
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
    "no item on the floor",
    "no people",
    "no characters",
    "no creatures",
    "no animals",
    "no text",
    "no logos",
    "no symbols",
    "no UI",
    "no HUD",
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
// Room builders — one per puzzle archetype
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
  const WALL_TOP = 130;
  const WALL_BOT = FLOOR_TOP - 20;
  const FLOOR_BOT = H - 40;
  const doorW = 180;
  const doorH = 340;
  const doorX = W - doorW - 30;
  const doorY = WALL_TOP - 10;
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
    requires: `door_${`room${i}`}_unlocked`,
    description,
  };
}

function makeWallDeco(
  base: ThemeDef,
  rng: () => number,
  i: number,
  layout: RoomLayout,
  excludeIdx?: number,
): RoomObject {
  let idx = randInt(rng, 0, base.decoStyles.length - 1);
  if (excludeIdx !== undefined && idx === excludeIdx)
    idx = (idx + 1) % base.decoStyles.length;
  return {
    id: `room${i}_deco_wall`,
    name: "deco_wall",
    prompt: `${base.decoStyles[idx]}, ${OBJ_STYLE}`,
    x: randInt(rng, 8, 22),
    y: layout.WALL_BOT - 130,
    width: 88,
    height: 130,
    collidable: false,
    interactable: false,
    removeBackground: true,
    kind: "decoration",
  };
}

function buildRoom(
  rng: () => number,
  base: ThemeDef,
  i: number,
  numRooms: number,
  arch: PuzzleArchetype,
): RoomPlan {
  const isLast = i === numRooms - 1;
  const isFirst = i === 0;
  const roomId = `room${i}`;
  const layout = makeLayout();

  // Difficulty curve: room 0 = easy / 3 elements, mid = 4, last = 5.
  // Scales the size of the active puzzle so later rooms feel harder.
  const elements = isFirst ? 3 : isLast ? 5 : 4;

  let objects: RoomObject[];
  let archIntro: string;

  if (arch === "collect") {
    [objects, archIntro] = buildCollectRoom(rng, base, i, isLast, layout, elements);
  } else if (arch === "sequence") {
    [objects, archIntro] = buildSequenceRoom(rng, base, i, isLast, layout, elements);
  } else {
    [objects, archIntro] = buildSwitchesRoom(rng, base, i, isLast, layout, elements);
  }

  const baseIntro = isFirst
    ? `You wake up in the ${base.rooms[i]}. The door behind you is sealed.`
    : isLast
      ? `You enter the final room: the ${base.rooms[i]}. Freedom is close.`
      : `You step into the ${base.rooms[i]}. The deeper you go, the stranger it gets.`;

  return {
    id: roomId,
    name: base.rooms[i] ?? `Room ${i + 1}`,
    background_prompt: base.bgs[i] ?? base.bgs[0]!,
    ambient_color: base.ambient[i] ?? "#0a0a14",
    objects,
    intro: `${baseIntro}\n\n${archIntro}`,
  };
}

// ---------------- A) COLLECT & COMBINE ----------------

function buildCollectRoom(
  rng: () => number,
  base: ThemeDef,
  i: number,
  isLast: boolean,
  layout: RoomLayout,
  elements: number,
): [RoomObject[], string] {
  const roomId = `room${i}`;
  const objects: RoomObject[] = [];
  const N = Math.max(2, Math.min(5, elements));

  objects.push(
    makeDoor(
      base,
      i,
      isLast,
      layout,
      `A heavy door. The lock takes ${N} offerings — find them and place them on the pedestal.`,
    ),
  );
  objects.push(makeWallDeco(base, rng, i, layout));

  // Spread N item slots across the floor band, leaving space for the pedestal
  // at center-back. Slot 0 = far left, last slot = far right.
  const itemSlots: { x: number; y: number; w: number; h: number }[] = [];
  const lanes = N;
  const laneW = 1020 / lanes;
  for (let k = 0; k < N; k++) {
    const cx = 60 + laneW * k + randInt(rng, 0, Math.max(1, Math.floor(laneW - 70)));
    // alternate between low (front floor) and high (back floor) so they read
    const high = k % 2 === 0;
    const y = high ? layout.FLOOR_BOT - 65 : layout.FLOOR_BOT - 105;
    itemSlots.push({ x: cx, y, w: 60, h: 60 });
  }

  const itemIds: string[] = [];
  for (let k = 0; k < N; k++) {
    const id = `${roomId}_item${k}`;
    const slot = itemSlots[k]!;
    const promptIdx = k % base.itemPrompts.length;
    objects.push({
      id,
      name: `item${k}`,
      prompt: `${base.itemPrompts[promptIdx]}, ${OBJ_STYLE}`,
      x: slot.x,
      y: slot.y,
      width: slot.w,
      height: slot.h,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "item",
      gives: id,
      puzzle: "collect",
      description: "A small object. You can pick it up.",
    });
    itemIds.push(id);
  }

  // pedestal — center on back floor, accepts all items
  objects.push({
    id: `${roomId}_pedestal`,
    name: "pedestal",
    prompt: `${base.pedestalPrompt}, ${OBJ_STYLE}`,
    x: randInt(rng, 540, 660),
    y: layout.FLOOR_BOT - 160,
    width: 160,
    height: 160,
    collidable: true,
    interactable: true,
    removeBackground: true,
    kind: "pedestal",
    acceptsItems: itemIds,
    puzzle: "collect",
    description: `A pedestal with ${N} empty slots. It seems to be waiting for offerings.`,
  });

  return [
    objects,
    `${N} offerings are scattered around. Pick each one up and place it on the pedestal — in any order.`,
  ];
}

// ---------------- B) SYMBOL SEQUENCE ----------------

function buildSequenceRoom(
  rng: () => number,
  base: ThemeDef,
  i: number,
  isLast: boolean,
  layout: RoomLayout,
  elements: number,
): [RoomObject[], string] {
  const roomId = `room${i}`;
  const objects: RoomObject[] = [];
  const N = Math.max(3, Math.min(5, elements));

  // Pick N unique symbols
  const pool = [...SYMBOL_POOL];
  const seq: string[] = [];
  for (let k = 0; k < N; k++) {
    const idx = randInt(rng, 0, pool.length - 1);
    seq.push(pool.splice(idx, 1)[0]!);
  }

  objects.push(
    makeDoor(
      base,
      i,
      isLast,
      layout,
      "The door has no handle, only a faint hum. The wall buttons must be pressed in the right order.",
    ),
  );
  objects.push(makeWallDeco(base, rng, i, layout));

  // Mural — back wall, left side, shows the sequence
  objects.push({
    id: `${roomId}_mural`,
    name: "mural",
    prompt: `${base.muralPrompt}, ${OBJ_STYLE}`,
    x: randInt(rng, 110, 220),
    y: layout.WALL_TOP + 20,
    width: 220,
    height: 130,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "sequence_clue",
    sequenceSymbols: seq,
    puzzle: "sequence",
    description: `A mural shows ${N} symbols glowing in a sequence.`,
  });

  // N buttons on the floor band, displayed in *shuffled* order so the sequence
  // matters (not just left-to-right).
  const order = Array.from({ length: N }, (_, k) => k);
  for (let s = order.length - 1; s > 0; s--) {
    const j = randInt(rng, 0, s);
    [order[s], order[j]] = [order[j]!, order[s]!];
  }
  const buttonY = layout.FLOOR_BOT - 100;
  const totalW = 1020;
  const stepX = totalW / N;
  const startX = 90;
  for (let k = 0; k < N; k++) {
    const symbolIdx = order[k]!;
    objects.push({
      id: `${roomId}_btn${k}`,
      name: `btn${k}`,
      prompt: `${base.buttonPrompt}, ${OBJ_STYLE}`,
      x: Math.round(startX + k * stepX),
      y: buttonY,
      width: 78,
      height: 78,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "sequence_button",
      symbol: seq[symbolIdx]!,
      symbolIndex: symbolIdx,
      puzzle: "sequence",
      description: `A button engraved with the symbol ${seq[symbolIdx]}.`,
    });
  }

  return [
    objects,
    `Read the mural's order, then press the ${N} wall buttons in the correct sequence.`,
  ];
}

// ---------------- C) LOGIC SWITCHES ----------------

function buildSwitchesRoom(
  rng: () => number,
  base: ThemeDef,
  i: number,
  isLast: boolean,
  layout: RoomLayout,
  elements: number,
): [RoomObject[], string] {
  const roomId = `room${i}`;
  const objects: RoomObject[] = [];
  const N = Math.max(3, Math.min(6, elements));

  // Target pattern: N booleans, ensure between ⌈N/3⌉ and N-1 are ON so it's
  // never trivial (all on / all off) and never empty.
  const minOn = Math.ceil(N / 3);
  const maxOn = N - 1;
  let target: boolean[] = [];
  let triesLeft = 64;
  do {
    target = Array.from({ length: N }, () => rng() < 0.5);
    triesLeft--;
  } while (
    triesLeft > 0 &&
    (target.filter((b) => b).length < minOn || target.filter((b) => b).length > maxOn)
  );

  // Initial pattern — guarantee it doesn't already match
  let initial: boolean[] = [];
  do {
    initial = Array.from({ length: N }, () => rng() < 0.5);
  } while (initial.every((v, idx) => v === target[idx]));

  objects.push(
    makeDoor(
      base,
      i,
      isLast,
      layout,
      "The door's lock is wired to the wall switches. Find the right combination.",
    ),
  );
  objects.push(makeWallDeco(base, rng, i, layout));

  // Switches across the back wall — distribute evenly
  const switchY = layout.WALL_TOP + 50;
  const totalW = 1020;
  const stepX = totalW / N;
  const startX = 80;
  for (let k = 0; k < N; k++) {
    objects.push({
      id: `${roomId}_sw${k}`,
      name: `sw${k}`,
      prompt: `${base.switchPrompt}, ${OBJ_STYLE}`,
      x: Math.round(startX + k * stepX),
      y: switchY,
      width: 68,
      height: 100,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "switch",
      symbol: String(k + 1),
      initialOn: initial[k],
      targetOn: target[k],
      puzzle: "switches",
      description: `Switch #${k + 1}. Click to toggle.`,
    });
  }

  const cluePattern = target
    .map((on, idx) => `${idx + 1}:${on ? "ON" : "OFF"}`)
    .join("  ");
  objects.push({
    id: `${roomId}_clue`,
    name: "clue",
    prompt: `${base.cluePropPrompt}, ${OBJ_STYLE}`,
    x: randInt(rng, 350, 470),
    y: layout.FLOOR_BOT - 120,
    width: 110,
    height: 120,
    collidable: true,
    interactable: true,
    removeBackground: true,
    kind: "switch_clue",
    symbol: cluePattern,
    puzzle: "switches",
    description: `A diagram. It shows which of the ${N} switches must be ON to unlock the door:\n\n${cluePattern}`,
  });

  return [
    objects,
    `Find the clue prop, then set the ${N} wall switches to the pattern it shows.`,
  ];
}
