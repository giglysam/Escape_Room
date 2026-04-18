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
  rooms: RoomPlan[];
}

const W = 1024;
const H = 640;
const FLOOR_TOP = 360;

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
    bgs: [
      `dark futuristic AI laboratory empty interior, glowing blue server racks along the walls, holographic readouts, ${BG_STYLE}`,
      `abandoned cyberpunk server room empty interior, red emergency lights, tangled fiber optic cables on the walls, ${BG_STYLE}`,
      `secret AI vault empty interior, glowing lines of code projected on the back wall, ${BG_STYLE}`,
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
    bgs: [
      `old Beirut antique shop empty interior, ottoman lamps on shelves, persian rug on the floor, dusty bookshelves on the back wall, warm cinematic light, ${BG_STYLE}`,
      `phoenician hidden chamber empty interior, stone tablets carved into the back wall, brass mechanisms, torchlight, ${BG_STYLE}`,
      `rooftop courtyard above old Beirut at night, moonlit, ornate carved stone wall, ${BG_STYLE}`,
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
    bgs: [
      `interior of a derelict spaceship corridor, empty, flickering ceiling lights, floating dust, ${BG_STYLE}`,
      `spaceship engine room empty interior, broken plasma conduits along the back wall, sparks, ${BG_STYLE}`,
      `spaceship escape pod bay empty interior, sealed circular hatch on the back wall, warning lights, ${BG_STYLE}`,
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
    bgs: [
      `interior of an old witch wooden cabin, empty, hanging herbs from the ceiling, candlelight, ${BG_STYLE}`,
      `stone cellar empty interior under a witch cabin, runic circle on the stone floor, ${BG_STYLE}`,
      `moonlit forest clearing at night, ${BG_STYLE}`,
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
function buildCustomTheme(theme: string): ThemeDef {
  const t = theme.trim();
  // Three sub-locations let the playthrough feel like a journey, all inside
  // the theme's world. Phrased as "of {theme}" so the model treats {theme}
  // as the world, not a furniture style.
  return {
    title: `Custom Run · ${t}`,
    story: `You are trapped inside a place themed around ${t}. Solve the puzzles in each room to escape.`,
    rooms: [`Entrance of ${t}`, `Heart of ${t}`, `Exit of ${t}`],
    ambient: ["#0c0c18", "#180c10", "#0a1018"],
    bgs: [
      `entrance area inside the world of ${t}, empty room interior with back wall and floor visible, environment fully themed around ${t}, single empty space, ${BG_STYLE}`,
      `central chamber inside the world of ${t}, empty room interior with thematic decorations on the back wall, environment fully themed around ${t}, ${BG_STYLE}`,
      `exit chamber inside the world of ${t}, empty room interior with a tall ornate door on the back wall, environment fully themed around ${t}, ${BG_STYLE}`,
    ],
    doorPrompts: [
      `tall ornate door themed around ${t}, fits the world of ${t}`,
      `heavy decorated door themed around ${t}, fits the world of ${t}`,
      `final exit door themed around ${t}, fits the world of ${t}, glowing edges`,
    ],
    decoStyles: [
      `small thematic object related to ${t}`,
      `small everyday item that fits inside the world of ${t}`,
      `small symbolic prop representing ${t}`,
      `small lit lamp or light source styled to fit ${t}`,
      `small piece of furniture-sized prop that belongs in ${t}`,
    ],
    itemPrompts: [
      `small ritual item number one belonging to the world of ${t}, single small object`,
      `small ritual item number two belonging to the world of ${t}, single small object`,
      `small ritual item number three belonging to the world of ${t}, single small object`,
    ],
    pedestalPrompt: `ornate pedestal or altar with three empty receptacles on top, themed around ${t}, fits the world of ${t}`,
    muralPrompt: `wall mural or display showing a sequence of four glowing symbols, themed around ${t}, fits the world of ${t}`,
    buttonPrompt: `small button with a single glowing symbol, themed around ${t}, fits the world of ${t}`,
    switchPrompt: `wall mounted toggle switch or lever with a status indicator, themed around ${t}, fits the world of ${t}`,
    cluePropPrompt: `small clue prop showing a diagram of switches with some highlighted, themed around ${t}, fits the world of ${t}`,
  };
}

export const PLAN_CANVAS = { width: W, height: H, floorTop: FLOOR_TOP };

const OBJ_STYLE =
  "single small object only, centered subject on a pure plain solid white background, isolated, no shadow, product photo style, no environment, no room, no building, no house, no cabin, no architecture, no people, no creatures, no text, ultra detailed, sharp focus";

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
    rooms.push(buildRoom(rng, base, i, numRooms, arch));
  }

  return {
    title: titleOverride,
    story: base.story,
    difficulty: req.difficulty ?? "normal",
    rooms,
  };
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
  const WALL_TOP = 110;
  const WALL_BOT = FLOOR_TOP - 20;
  const FLOOR_BOT = H - 30;
  const doorW = 150;
  const doorH = 290;
  const doorX = W - doorW - 22;
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

  let objects: RoomObject[];
  let archIntro: string;

  if (arch === "collect") {
    [objects, archIntro] = buildCollectRoom(rng, base, i, isLast, layout);
  } else if (arch === "sequence") {
    [objects, archIntro] = buildSequenceRoom(rng, base, i, isLast, layout);
  } else {
    [objects, archIntro] = buildSwitchesRoom(rng, base, i, isLast, layout);
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
): [RoomObject[], string] {
  const roomId = `room${i}`;
  const objects: RoomObject[] = [];

  objects.push(
    makeDoor(
      base,
      i,
      isLast,
      layout,
      "A heavy door. The lock takes three offerings — find them and place them on the pedestal.",
    ),
  );
  objects.push(makeWallDeco(base, rng, i, layout));

  // 3 collectible items spread across the floor
  const itemSlots = [
    { x: randInt(rng, 70, 130), y: layout.FLOOR_BOT - 70, w: 60, h: 60 },
    { x: randInt(rng, 290, 360), y: layout.FLOOR_BOT - 70, w: 60, h: 60 },
    { x: randInt(rng, 720, 770), y: layout.FLOOR_BOT - 70, w: 60, h: 60 },
  ];
  const itemIds: string[] = [];
  for (let k = 0; k < 3; k++) {
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

  // pedestal — back-wall mid, accepts the three items
  objects.push({
    id: `${roomId}_pedestal`,
    name: "pedestal",
    prompt: `${base.pedestalPrompt}, ${OBJ_STYLE}`,
    x: randInt(rng, 460, 540),
    y: layout.FLOOR_BOT - 150,
    width: 150,
    height: 150,
    collidable: true,
    interactable: true,
    removeBackground: true,
    kind: "pedestal",
    acceptsItems: itemIds,
    puzzle: "collect",
    description: "A pedestal with three empty slots. It seems to be waiting for offerings.",
  });

  return [
    objects,
    "Three offerings are scattered around. Pick each one up and place it on the pedestal — in any order.",
  ];
}

// ---------------- B) SYMBOL SEQUENCE ----------------

function buildSequenceRoom(
  rng: () => number,
  base: ThemeDef,
  i: number,
  isLast: boolean,
  layout: RoomLayout,
): [RoomObject[], string] {
  const roomId = `room${i}`;
  const objects: RoomObject[] = [];

  // Pick 4 unique symbols
  const pool = [...SYMBOL_POOL];
  const seq: string[] = [];
  for (let k = 0; k < 4; k++) {
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
    x: randInt(rng, 90, 160),
    y: layout.WALL_TOP + 20,
    width: 220,
    height: 130,
    collidable: false,
    interactable: true,
    removeBackground: true,
    kind: "sequence_clue",
    sequenceSymbols: seq,
    puzzle: "sequence",
    description: "A mural shows four symbols glowing in a sequence.",
  });

  // 4 buttons on the back wall, displayed in *shuffled* order so the sequence
  // matters (not just left-to-right).
  const order = [0, 1, 2, 3];
  for (let s = order.length - 1; s > 0; s--) {
    const j = randInt(rng, 0, s);
    [order[s], order[j]] = [order[j]!, order[s]!];
  }
  const buttonY = layout.FLOOR_BOT - 90;
  const startX = 70;
  const stepX = 130;
  for (let k = 0; k < 4; k++) {
    const symbolIdx = order[k]!;
    objects.push({
      id: `${roomId}_btn${k}`,
      name: `btn${k}`,
      prompt: `${base.buttonPrompt}, ${OBJ_STYLE}`,
      x: startX + k * stepX,
      y: buttonY,
      width: 80,
      height: 80,
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
    "Read the mural's order, then press the four wall buttons in the correct sequence.",
  ];
}

// ---------------- C) LOGIC SWITCHES ----------------

function buildSwitchesRoom(
  rng: () => number,
  base: ThemeDef,
  i: number,
  isLast: boolean,
  layout: RoomLayout,
): [RoomObject[], string] {
  const roomId = `room${i}`;
  const objects: RoomObject[] = [];

  // Target pattern: 4 booleans, at least 2 ON, at least 1 OFF
  let target: boolean[] = [];
  let triesLeft = 32;
  do {
    target = [0, 1, 2, 3].map(() => rng() < 0.5);
    triesLeft--;
  } while (
    triesLeft > 0 &&
    (target.filter((b) => b).length < 2 || target.filter((b) => b).length > 3)
  );

  // Initial pattern — guarantee it doesn't already match
  let initial: boolean[] = [];
  do {
    initial = [0, 1, 2, 3].map(() => rng() < 0.5);
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

  // 4 switches on the back wall
  const switchY = layout.WALL_TOP + 50;
  const startX = 60;
  const stepX = 130;
  for (let k = 0; k < 4; k++) {
    objects.push({
      id: `${roomId}_sw${k}`,
      name: `sw${k}`,
      prompt: `${base.switchPrompt}, ${OBJ_STYLE}`,
      x: startX + k * stepX,
      y: switchY,
      width: 70,
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

  // Clue prop — small floor object that shows the right pattern
  const cluePattern = target
    .map((on, idx) => `${idx + 1}:${on ? "ON" : "OFF"}`)
    .join("  ");
  objects.push({
    id: `${roomId}_clue`,
    name: "clue",
    prompt: `${base.cluePropPrompt}, ${OBJ_STYLE}`,
    x: randInt(rng, 290, 380),
    y: layout.FLOOR_BOT - 120,
    width: 110,
    height: 120,
    collidable: true,
    interactable: true,
    removeBackground: true,
    kind: "switch_clue",
    symbol: cluePattern,
    puzzle: "switches",
    description: `A diagram. It shows which of the four switches must be ON to unlock the door:\n\n${cluePattern}`,
  });

  return [
    objects,
    "Find the clue prop, then set the four wall switches to the pattern it shows.",
  ];
}
