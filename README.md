# Neural Escape — AI-Generated Escape Room

An advanced **point-and-click escape room** where every room, prop and puzzle is generated **on demand** by AI. Built with React + TypeScript + Vite. Deploys to **Vercel** in one click.

> Each playthrough plans a brand new game (theme, story, 3 rooms, 4 puzzles per room), then calls a free image API to generate the background and every prop, removes the white background of each prop in the browser, and drops them into a 2D scene with proper physics, collisions and depth-sorting.

---

## Highlights

- **AI image generation** for every background and every prop (via `simple-generator-five.vercel.app`).
- **LLM theme planning** (best-effort, via `grok3.wasmer.app`) with a strong **procedural fallback** so the game **always** works, even offline.
- **Client-side background removal** (chroma-key flood fill from the corners + edge feathering + transparent trim) so AI-generated props composite cleanly on top of generated backgrounds.
- **Aspect-correct sprite placement** — props are scaled to fit their bounding box without distortion.
- **Real game engine**: side-scrolling movement (WASD / arrows), depth-sorted rendering, proper collision boxes (only the bottom of each sprite is solid), interaction radius prompts, hover highlights, vignette + ambient lighting.
- **Real puzzles**: every room has a riddle on a hidden note → that unlocks a container with a 4-digit code → the keypad gives you a key card → the key card opens the door to the next room. Final room → exit.
- **Inventory + flags + state machine** for clean progression.
- **Per-prompt asset cache** in `localStorage` — replays load instantly, no API calls.
- **Serverless API proxies** so the game works in the browser despite the third-party APIs not allowing CORS.
- **Vercel-ready**: `vercel.json` configured, `/api/*` functions, SPA rewrites, image responses cached at the edge.

---

## Run locally

```bash
npm install
npm run dev
# open http://localhost:5173
```

For the AI APIs to work locally, run with the Vercel CLI so the `/api/*` functions are served:

```bash
npm install -g vercel
vercel dev
```

If you just `npm run dev`, the game will detect that `/api/*` is unavailable and fall back to the **fully procedural offline planner** (still 100% playable — backgrounds and props will use placeholder boxes).

---

## Deploy to Vercel

1. Push this repo to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new), import the repo.
3. Vercel will autodetect Vite. The included `vercel.json` already wires up the `api/` serverless functions and the SPA rewrites.
4. Hit **Deploy**.

That's it — no env vars, no secrets, no setup.

---

## How a playthrough works

1. Player enters a theme (or leaves it blank for a random one).
2. Front-end calls `/api/plan` → returns a `GamePlan` JSON (3 rooms, ~6 props per room, riddles + codes).
3. Front-end iterates the plan and, for each background and each prop, calls `/api/generate-image`. This serverless proxy talks to the upstream image API (with the same headers / session warm-up your script used), downloads the JPG, and returns it as a base64 data URL — bypassing CORS entirely.
4. Each prop image is run through `removeBackground()` in the browser (corner flood-fill chroma key) and `trimTransparent()` to crop tightly. The cleaned cutout becomes a transparent canvas.
5. The game engine starts. Backgrounds are aspect-cover-fitted to the canvas. Props are aspect-contain-fitted into their planned bounding box. The player is rendered procedurally (no asset needed).
6. Solve the puzzles. Reach the exit.

---

## Project structure

```
api/
  _utils.ts            CORS + retry helpers for serverless functions
  generate-image.ts    POST /api/generate-image  → calls upstream image API, returns dataUrl
  plan.ts              POST /api/plan            → returns a GamePlan (LLM best-effort, procedural fallback)
src/
  shared/plan.ts       Pure-TS plan generator shared by client + serverless
  engine/
    imageUtils.ts      loadImage, fitContain, removeBackground, trimTransparent
    assetManager.ts    Batched asset generation with progress + localStorage cache
    player.ts          Procedurally-drawn player sprite with walk animation
    game.ts            Main engine: input, collision, depth sort, render loop
  App.tsx              React UI: menu, loading screen, HUD, modals, keypad, riddle
  main.tsx
  styles.css
vercel.json
vite.config.ts
```

---

## Controls

- **Move**: `WASD` or arrow keys
- **Interact**: `E`, `Space`, `Enter`, or click
- Mouse hover highlights interactable objects
- Walk close to a prop to see the `[E]` interaction prompt

Built with: React 18, Vite 6, TypeScript 5, plain Canvas 2D (no game engine dependency).
