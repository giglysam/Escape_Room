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
  | "keypad"
  | "key"
  | "note"
  | "tool"
  | "switch"
  | "container"
  | "decoration"
  | "exit";

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
  requires?: string;
  gives?: string;
  riddle?: string;
  solution?: string;
  unlocks?: string;
  description?: string;
  hint?: string;
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

const RIDDLES: { q: string; a: string }[] = [
  {
    q: "I have keys but no locks. I have space but no room. You can enter, but you can't go inside. What am I?",
    a: "keyboard",
  },
  { q: "The more you take, the more you leave behind. What are they?", a: "footsteps" },
  {
    q: "I speak without a mouth and hear without ears. I have nobody, but come alive with the wind. What am I?",
    a: "echo",
  },
  { q: "What has hands but cannot clap?", a: "clock" },
  { q: "What runs but never walks, has a mouth but never talks?", a: "river" },
  { q: "What gets wetter the more it dries?", a: "towel" },
  { q: "I'm tall when I'm young, and short when I'm old. What am I?", a: "candle" },
  { q: "What has a face and two hands but no arms or legs?", a: "clock" },
  { q: "Forward I am heavy, backward I am not. What am I?", a: "ton" },
  { q: "What can travel around the world while staying in a corner?", a: "stamp" },
];

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
  /** Prompt fragment for the keypad / lock object on the wall. */
  keypadPrompt: string;
  /** Prompt fragment for the small container. */
  containerPrompt: string;
  /** Prompt fragment for the small clue note. */
  notePrompt: string;
  /** Pool of small thematic decoration objects (single objects, not buildings). */
  decoStyles: string[];
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
    keypadPrompt: "futuristic wall mounted electronic keypad with a glowing blue four digit display",
    containerPrompt: "small futuristic metal storage locker, slightly open",
    notePrompt: "small piece of crumpled paper with handwritten cryptic message",
    decoStyles: [
      "small vintage desktop server tower with blinking LEDs",
      "small tangle of fiber optic cables glowing blue",
      "broken holographic projector device",
      "lab beaker with glowing liquid",
      "discarded VR headset",
    ],
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
    keypadPrompt: "small brass mechanical lock dial with four engraved digits, antique",
    containerPrompt: "small ornate wooden treasure chest, slightly open",
    notePrompt: "old yellowed parchment scroll with handwritten arabic-style cryptic message",
    decoStyles: [
      "ornate ottoman oil lamp glowing",
      "stack of dusty old leather books",
      "brass arabian teapot",
      "small persian carpet rolled up",
      "engraved silver tray",
    ],
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
    keypadPrompt: "wall mounted spaceship access keypad with glowing four digit display",
    containerPrompt: "small spaceship storage locker with magnetic latch, slightly open",
    notePrompt: "small piece of plastic data card with printed access code",
    decoStyles: [
      "broken engineering helmet",
      "sparking power conduit segment",
      "floating zero-gravity coffee mug",
      "small portable oxygen tank",
      "discarded clipboard with technical schematics",
    ],
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
    keypadPrompt: "small wooden box with four engraved rune dials, mystical",
    containerPrompt: "small wooden chest bound with iron, slightly open",
    notePrompt: "old torn parchment with handwritten witch runes and a riddle",
    decoStyles: [
      "bubbling green potion bottle",
      "old wooden broomstick",
      "stack of spellbooks bound in leather",
      "wooden cauldron with smoke",
      "skull candle holder",
    ],
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
    keypadPrompt: `small four digit lock device themed around ${t}, fits the world of ${t}`,
    containerPrompt: `small container themed around ${t}, fits the world of ${t}, slightly open`,
    notePrompt: `small note or scroll themed around ${t}, fits the world of ${t}, with a handwritten cryptic message`,
    decoStyles: [
      `small thematic object related to ${t}`,
      `small everyday item that fits inside the world of ${t}`,
      `small symbolic prop representing ${t}`,
      `small lit lamp or light source styled to fit ${t}`,
      `small piece of furniture-sized prop that belongs in ${t}`,
    ],
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

  const usedRiddles = new Set<number>();
  const pickRiddle = () => {
    let i = randInt(rng, 0, RIDDLES.length - 1);
    let tries = 0;
    while (usedRiddles.has(i) && tries < 20) {
      i = randInt(rng, 0, RIDDLES.length - 1);
      tries++;
    }
    usedRiddles.add(i);
    return RIDDLES[i]!;
  };

  const rooms: RoomPlan[] = [];

  for (let i = 0; i < numRooms; i++) {
    const isLast = i === numRooms - 1;
    const isFirst = i === 0;
    const ridd = pickRiddle();
    const code = String(randInt(rng, 1000, 9999));
    const roomId = `room${i}`;

    /**
     * Slot-based layout — every prop is placed in a named slot so we never get
     * overlaps and the room reads cleanly left-to-right:
     *
     *   ┌─────────────────────────────────────────────────────────────────┐
     *   │  WALL_LEFT (deco1)         WALL_MID (keypad)    WALL_RIGHT (door)│ ← back wall
     *   │                                                                  │
     *   ├─── horizon  ────────────────────────────────────────────────────┤
     *   │ FLOOR_LEFT (deco2)   FLOOR_MID (container)   FLOOR_RIGHT (note) │ ← floor
     *   │                                                                  │
     *   │ ↳ player walks along the floor band                              │
     *   └─────────────────────────────────────────────────────────────────┘
     *
     * The door is always pinned to the right edge so the next-room transition
     * reads naturally. Decor never overlaps the keypad column or the door.
     */
    const WALL_TOP = 110; // top of the back-wall band
    const WALL_BOT = FLOOR_TOP - 20; // bottom of back-wall band
    const FLOOR_BOT = H - 30;

    // door — always right side, pinned to back wall, tall
    const doorW = 150;
    const doorH = 290;
    const doorX = W - doorW - 22;
    const doorY = WALL_TOP - 10;

    // keypad — back wall, middle-left of door, kept clear of wall-deco
    const keypadW = 90;
    const keypadH = 120;
    const keypadX = randInt(rng, 140, 240);
    const keypadY = WALL_TOP + 30;

    // wall-deco — back wall far left, kept clear of the keypad column
    const wallDecoW = 90;
    const wallDecoH = 140;
    const wallDecoX = randInt(rng, 8, 18);
    const wallDecoY = WALL_BOT - wallDecoH + 10;

    // container — on the floor, slightly right of center, far enough from door
    const contW = 130;
    const contH = 120;
    const contX = randInt(rng, 460, 540);
    const contY = FLOOR_BOT - contH;

    // floor-deco — front-left, between wall-deco and container
    const floorDecoW = 110;
    const floorDecoH = 130;
    const floorDecoX = randInt(rng, 250, 340);
    const floorDecoY = FLOOR_BOT - floorDecoH;

    // note — small, on the floor between container and door so it reads
    const noteW = 64;
    const noteH = 56;
    const noteMinX = contX + contW + 20;
    const noteMaxX = Math.max(noteMinX + 10, doorX - noteW - 18);
    const noteX = randInt(rng, noteMinX, noteMaxX);
    const noteY = FLOOR_BOT - noteH - 6;

    const objects: RoomObject[] = [];

    // ---- DOOR / EXIT ----
    const doorBase =
      base.doorPrompts[i] ?? base.doorPrompts[base.doorPrompts.length - 1] ?? "heavy door";
    const doorPrompt = isLast
      ? `${doorBase}, large heavy ornate exit door with glowing edges, ${OBJ_STYLE}`
      : `${doorBase}, closed, ${OBJ_STYLE}`;
    objects.push({
      id: `${roomId}_door`,
      name: "door",
      prompt: doorPrompt,
      x: doorX,
      y: doorY,
      width: doorW,
      height: doorH,
      collidable: true,
      interactable: true,
      removeBackground: true,
      kind: isLast ? "exit" : "door",
      requires: `key_${roomId}`,
      description: isLast
        ? "The final exit. It needs a key card to unlock."
        : "A heavy door. It seems to need a key from this room.",
    });

    // ---- KEYPAD ----
    objects.push({
      id: `${roomId}_keypad`,
      name: "keypad",
      prompt: `${base.keypadPrompt}, ${OBJ_STYLE}`,
      x: keypadX,
      y: keypadY,
      width: keypadW,
      height: keypadH,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "keypad",
      solution: code,
      gives: `key_${roomId}`,
      description: "A 4-digit keypad. Find the code somewhere in this room.",
      hint: `The code starts with ${code[0]}.`,
    });

    // ---- NOTE WITH RIDDLE ----
    objects.push({
      id: `${roomId}_note`,
      name: "note",
      prompt: `${base.notePrompt}, ${OBJ_STYLE}`,
      x: noteX,
      y: noteY,
      width: noteW,
      height: noteH,
      collidable: false,
      interactable: true,
      removeBackground: true,
      kind: "note",
      riddle: ridd.q,
      solution: ridd.a,
      description: `A scrap of paper. There's a riddle scribbled on it.\n\n"${ridd.q}"\n\nAnswer correctly to reveal a clue.`,
      hint: `Hint: it starts with the letter "${ridd.a[0]}".`,
    });

    // ---- CONTAINER (reveals code after riddle solved) ----
    objects.push({
      id: `${roomId}_container`,
      name: "container",
      prompt: `${base.containerPrompt}, ${OBJ_STYLE}`,
      x: contX,
      y: contY,
      width: contW,
      height: contH,
      collidable: true,
      interactable: true,
      removeBackground: true,
      kind: "container",
      requires: `riddle_${roomId}_solved`,
      gives: `code_${roomId}`,
      description: "A container. It looks locked. Maybe a clue first?",
    });

    // ---- DECORATIONS (non-overlapping, on opposite sides of the room) ----
    const decoIdx0 = randInt(rng, 0, base.decoStyles.length - 1);
    objects.push({
      id: `${roomId}_deco1`,
      name: "deco1",
      prompt: `${base.decoStyles[decoIdx0]}, ${OBJ_STYLE}`,
      x: wallDecoX,
      y: wallDecoY,
      width: wallDecoW,
      height: wallDecoH,
      collidable: false, // back-wall deco — don't block the player
      interactable: false,
      removeBackground: true,
      kind: "decoration",
    });

    let decoIdx1 = randInt(rng, 0, base.decoStyles.length - 1);
    if (decoIdx1 === decoIdx0) decoIdx1 = (decoIdx1 + 1) % base.decoStyles.length;
    objects.push({
      id: `${roomId}_deco2`,
      name: "deco2",
      prompt: `${base.decoStyles[decoIdx1]}, ${OBJ_STYLE}`,
      x: floorDecoX,
      y: floorDecoY,
      width: floorDecoW,
      height: floorDecoH,
      collidable: true,
      interactable: false,
      removeBackground: true,
      kind: "decoration",
    });

    rooms.push({
      id: roomId,
      name: base.rooms[i] ?? `Room ${i + 1}`,
      background_prompt: base.bgs[i] ?? base.bgs[0]!,
      ambient_color: base.ambient[i] ?? "#0a0a14",
      objects,
      intro: isFirst
        ? `You wake up in the ${base.rooms[i]}. The door behind you is sealed.`
        : isLast
          ? `You enter the final room: the ${base.rooms[i]}. Freedom is close.`
          : `You step into the ${base.rooms[i]}. The deeper you go, the stranger it gets.`,
    });
  }

  return {
    title: titleOverride,
    story: base.story,
    difficulty: req.difficulty ?? "normal",
    rooms,
  };
}
