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
  bgs: string[];
  rooms: string[];
  ambient: string[];
  containerStyle: "drawer" | "locker" | "chest";
  decoStyles: string[];
}

const THEMES: ThemeDef[] = [
  {
    title: "Neural Lab Breakout",
    story:
      "You wake inside a rogue AI research lab. Self-destruct in T-minus unknown. Find the override codes and escape before the neural core melts down.",
    bgs: [
      "dark futuristic AI laboratory interior, glowing blue server racks, holographic terminals, cinematic wide shot, side-scrolling perspective view, no people, ultra detailed concept art",
      "abandoned cyberpunk server room, red emergency lights, tangled fiber optic cables, side-scrolling perspective view, no people, dramatic lighting, ultra detailed",
      "secret AI vault with massive sealed bulkhead door, glowing runes of code on walls, side-scrolling perspective view, no people, ultra detailed",
    ],
    rooms: ["Control Room", "Server Vault", "Core Chamber"],
    ambient: ["#0b1424", "#1a0a14", "#0a1a18"],
    containerStyle: "locker",
    decoStyles: [
      "vintage server tower with blinking LEDs",
      "tangle of fiber optic cables glowing blue",
      "broken holographic projector",
    ],
  },
  {
    title: "Beirut Antiquarian Heist",
    story:
      "You're locked in a forgotten antique shop in old Beirut. Lebanese mosaics hide ancient mechanisms. Crack them before dawn or be sealed in forever.",
    bgs: [
      "old Beirut antique shop interior, ottoman lamps, persian rugs, dusty bookshelves, side-scrolling perspective view, warm cinematic light, no people, ultra detailed",
      "phoenician hidden chamber with stone tablets and brass mechanisms, torchlight, side-scrolling perspective view, no people, ultra detailed",
      "rooftop courtyard above old Beirut, moonlit, ornate door covered in carvings, side-scrolling perspective view, no people, ultra detailed",
    ],
    rooms: ["Antique Shop", "Hidden Chamber", "Rooftop Exit"],
    ambient: ["#1a1208", "#0e0a06", "#0a1018"],
    containerStyle: "chest",
    decoStyles: [
      "ornate ottoman oil lamp glowing",
      "stack of dusty old leather books",
      "brass arabian teapot",
    ],
  },
  {
    title: "Derelict Starship Sigma",
    story:
      "Cryo-sleep failed. The starship Sigma is silent and the airlock is sealed. Reroute power, override the captain's lock, reach the escape pod.",
    bgs: [
      "interior of a derelict spaceship corridor, flickering ceiling lights, floating dust, side-scrolling perspective view, no people, ultra detailed sci-fi concept art",
      "spaceship engine room with broken plasma conduits, sparks, side-scrolling perspective view, no people, ultra detailed",
      "spaceship escape pod bay with sealed circular hatch, warning lights, side-scrolling perspective view, no people, ultra detailed",
    ],
    rooms: ["Corridor", "Engine Room", "Pod Bay"],
    ambient: ["#06101a", "#1a0c06", "#040a14"],
    containerStyle: "locker",
    decoStyles: [
      "broken engineering helmet on the floor",
      "sparking power conduit",
      "floating zero-gravity coffee mug",
    ],
  },
  {
    title: "Witch's Mountain Cabin",
    story:
      "You sheltered from a storm in a cabin that locked behind you. Old runes and bubbling potions hint at a way out — if you can read them in time.",
    bgs: [
      "interior of an old witch's wooden cabin, hanging herbs, glowing potion bottles, candlelight, side-scrolling perspective view, no people, ultra detailed",
      "stone cellar under a witch's cabin, runic circle on the floor, side-scrolling perspective view, no people, ultra detailed",
      "moonlit forest clearing with a heavy iron gate covered in runes, side-scrolling perspective view, no people, ultra detailed",
    ],
    rooms: ["Cabin", "Cellar", "Forest Gate"],
    ambient: ["#100a04", "#08040a", "#040a08"],
    containerStyle: "chest",
    decoStyles: [
      "bubbling green potion bottle",
      "old wooden broomstick",
      "stack of spellbooks bound in leather",
    ],
  },
];

export const PLAN_CANVAS = { width: W, height: H, floorTop: FLOOR_TOP };

const OBJ_STYLE =
  "centered subject on a pure plain solid white background, isolated, no shadow, product photo style, no environment, no people, ultra detailed, sharp focus";

export function generateProceduralPlan(req: PlanReq = {}): GamePlan {
  const seed = req.seed ?? Math.floor(Math.random() * 1e9);
  const rng = mulberry32(seed);

  // If user typed a theme, blend it with a base template (use first theme)
  // but keep visual variety by also picking randomly within prompts.
  const base = req.theme ? THEMES[0]! : pick(rng, THEMES);
  const titleOverride = req.theme ? `Custom Run · ${req.theme}` : base.title;

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

    const objects: RoomObject[] = [];

    // ---- DOOR / EXIT ----
    const themeForCustom = req.theme ? `${req.theme}, ` : "";
    const doorPrompt = isLast
      ? `${themeForCustom}large heavy ornate exit door with glowing edges, ${OBJ_STYLE}`
      : `${themeForCustom}closed heavy interior door with a small panel, ${OBJ_STYLE}`;

    objects.push({
      id: `${roomId}_door`,
      name: "door",
      prompt: doorPrompt,
      x: 860,
      y: 200,
      width: 140,
      height: 280,
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
      prompt: `${themeForCustom}wall mounted electronic keypad with a glowing 4 digit display, ${OBJ_STYLE}`,
      x: randInt(rng, 70, 220),
      y: 180,
      width: 96,
      height: 130,
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
      prompt: `${themeForCustom}crumpled paper note with handwritten cryptic message, ${OBJ_STYLE}`,
      x: randInt(rng, 380, 720),
      y: randInt(rng, FLOOR_TOP + 10, H - 110),
      width: 70,
      height: 60,
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
    const containerPrompt =
      base.containerStyle === "drawer"
        ? `${themeForCustom}wooden drawer slightly open, ${OBJ_STYLE}`
        : base.containerStyle === "chest"
          ? `${themeForCustom}small treasure chest slightly open, ${OBJ_STYLE}`
          : `${themeForCustom}metal storage locker slightly open, ${OBJ_STYLE}`;

    objects.push({
      id: `${roomId}_container`,
      name: "container",
      prompt: containerPrompt,
      x: randInt(rng, 290, 560),
      y: 360,
      width: 110,
      height: 110,
      collidable: true,
      interactable: true,
      removeBackground: true,
      kind: "container",
      requires: `riddle_${roomId}_solved`,
      gives: `code_${roomId}`,
      description: "A container. It looks locked. Maybe a clue first?",
    });

    // ---- DECOR pieces ----
    const decoIdx0 = randInt(rng, 0, base.decoStyles.length - 1);
    objects.push({
      id: `${roomId}_deco1`,
      name: "deco1",
      prompt: `${themeForCustom}${base.decoStyles[decoIdx0]}, ${OBJ_STYLE}`,
      x: randInt(rng, 60, 220),
      y: randInt(rng, FLOOR_TOP - 40, H - 220),
      width: 90,
      height: 130,
      collidable: true,
      interactable: false,
      removeBackground: true,
      kind: "decoration",
    });

    let decoIdx1 = randInt(rng, 0, base.decoStyles.length - 1);
    if (decoIdx1 === decoIdx0) decoIdx1 = (decoIdx1 + 1) % base.decoStyles.length;
    objects.push({
      id: `${roomId}_deco2`,
      name: "deco2",
      prompt: `${themeForCustom}${base.decoStyles[decoIdx1]}, ${OBJ_STYLE}`,
      x: randInt(rng, 600, 800),
      y: randInt(rng, FLOOR_TOP - 30, H - 200),
      width: 90,
      height: 120,
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
