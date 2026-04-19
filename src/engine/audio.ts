/**
 * Lightweight WebAudio sound effects + ambient hum.
 *
 * No external assets — every sound is synthesised from simple oscillators
 * and an envelope. This keeps the bundle tiny and works on Vercel / SPA
 * with zero asset hosting.
 */

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let ambientNode: { stop: () => void } | null = null;
let muted = false;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 0.55;
    masterGain.connect(ctx.destination);
  }
  // Some browsers suspend the context until a user gesture
  if (ctx.state === "suspended") ctx.resume().catch(() => undefined);
  return ctx;
}

export function setMuted(v: boolean) {
  muted = v;
  if (masterGain) masterGain.gain.value = v ? 0 : 0.55;
}

export function isMuted(): boolean {
  return muted;
}

function envelope(
  c: AudioContext,
  gain: GainNode,
  attack: number,
  decay: number,
  peak: number,
) {
  const t = c.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(
  freq: number,
  durMs: number,
  type: OscillatorType = "sine",
  peak = 0.45,
  detuneRamp?: number,
) {
  const c = getCtx();
  if (!c || !masterGain) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  if (detuneRamp !== undefined) {
    osc.frequency.linearRampToValueAtTime(freq + detuneRamp, c.currentTime + durMs / 1000);
  }
  osc.connect(g);
  g.connect(masterGain);
  envelope(c, g, 0.005, durMs / 1000, peak);
  osc.start();
  osc.stop(c.currentTime + durMs / 1000 + 0.05);
}

export function playClick() {
  tone(620, 80, "square", 0.18);
}

export function playSuccess() {
  // Major arpeggio C5 - E5 - G5
  tone(523.25, 140, "triangle", 0.35);
  setTimeout(() => tone(659.25, 140, "triangle", 0.35), 90);
  setTimeout(() => tone(783.99, 200, "triangle", 0.4), 180);
}

export function playFail() {
  tone(220, 220, "sawtooth", 0.3, -80);
}

export function playBigSuccess() {
  // Resolved triad
  tone(523.25, 350, "triangle", 0.45);
  setTimeout(() => tone(659.25, 350, "triangle", 0.45), 60);
  setTimeout(() => tone(783.99, 500, "triangle", 0.5), 120);
}

export function playUnlock() {
  // Two-stage clunk
  tone(140, 90, "square", 0.4);
  setTimeout(() => tone(90, 180, "sawtooth", 0.5), 110);
}

export function playPickup() {
  tone(880, 80, "sine", 0.3);
  setTimeout(() => tone(1320, 90, "sine", 0.3), 60);
}

export function playWin() {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((n, idx) => setTimeout(() => tone(n, 280, "triangle", 0.5), idx * 130));
}

export function playLose() {
  // Descending chromatic minor scale
  const notes = [440, 415.3, 392, 369.99, 349.23];
  notes.forEach((n, idx) => setTimeout(() => tone(n, 320, "sawtooth", 0.45), idx * 180));
}

export function playWarning() {
  // Two-tone alarm beep
  tone(880, 140, "square", 0.35);
  setTimeout(() => tone(660, 140, "square", 0.35), 160);
}

/**
 * Start an ambient room hum — gently noisy low tone. Returns a stop fn.
 * Calling startAmbient again replaces the previous hum.
 */
export function startAmbient(opts: { intensity?: number } = {}) {
  const c = getCtx();
  if (!c || !masterGain) return;
  if (ambientNode) ambientNode.stop();

  const intensity = opts.intensity ?? 0.5;

  const osc1 = c.createOscillator();
  osc1.type = "sine";
  osc1.frequency.value = 60;
  const osc2 = c.createOscillator();
  osc2.type = "sine";
  osc2.frequency.value = 90;

  const g = c.createGain();
  g.gain.value = 0;
  g.gain.linearRampToValueAtTime(0.05 * intensity, c.currentTime + 1.2);

  osc1.connect(g);
  osc2.connect(g);
  g.connect(masterGain);
  osc1.start();
  osc2.start();

  ambientNode = {
    stop: () => {
      try {
        const tNow = c.currentTime;
        g.gain.cancelScheduledValues(tNow);
        g.gain.setValueAtTime(g.gain.value, tNow);
        g.gain.linearRampToValueAtTime(0, tNow + 0.4);
        osc1.stop(tNow + 0.5);
        osc2.stop(tNow + 0.5);
      } catch {
        /* ignore */
      }
      ambientNode = null;
    },
  };
}

export function stopAmbient() {
  if (ambientNode) ambientNode.stop();
}
