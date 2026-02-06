/*
  Nanobot Drift
  -------------
  A self-contained browser mini-game designed to run standalone OR embedded in an iframe.

  Embedding contract (postMessage):
    Host -> Game: { type: "init", gameId, roomId, username, allowAbort, seed? }
    Game -> Host: { type: "outcome", outcome: "win"|"lose"|"abort", payload? }

  Notes:
    - No network calls
    - No external assets
    - Canvas2D rendering
*/

const GAME_ID_DEFAULT = "nanobot-drift";
const VERSION = "1.0.0";
const TOTAL_ROUNDS = 20;
const FINAL_ROUND_BEACON_MULT = 0.25;
const FINAL_ROUND_EMP_CHARGES = 1;
const EMP_BASE_COOLDOWN = 6.0;
const EMP_COOLDOWN_PER_ROUND = 2.0;
const BEACON_CHARGE_RATE = 0.125;

type Outcome = "win" | "lose" | "abort";

type HostInitMessage = {
  type: "init";
  gameId?: string;
  roomId?: string | number;
  username?: string;
  allowAbort?: boolean;
  seed?: string | number;
};

type OutcomeMessage = {
  type: "outcome";
  outcome: Outcome;
  payload?: Record<string, unknown>;
};

type ReadyMessage = {
  type: "ready";
  gameId: string;
  version: string;
};

type HostConfig = {
  gameId: string;
  roomId: string;
  username: string;
  allowAbort: boolean;
  seed: number;
};

type GameState =
  | { kind: "boot" }
  | { kind: "title" }
  | { kind: "playing" }
  | { kind: "paused" }
  | { kind: "round_complete" }
  | { kind: "result"; outcome: Outcome; sent: boolean };

// -----------------------------
// Utilities
// -----------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

function wrap(v: number, max: number): number {
  if (v < 0) return v + max;
  if (v >= max) return v - max;
  return v;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function nowMs(): number {
  return performance.now();
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function safeString(x: unknown, fallback: string): string {
  return typeof x === "string" && x.trim().length > 0 ? x : fallback;
}

function safeBoolean(x: unknown, fallback: boolean): boolean {
  return typeof x === "boolean" ? x : fallback;
}

function safeNumber(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function seedFromUnknown(seed: unknown): number {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return (seed >>> 0) || 0x12345678;
  }
  if (typeof seed === "string") {
    return hashStringToU32(seed);
  }
  // Default: use crypto if available
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] || 0x12345678;
  } catch {
    return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 0x12345678;
  }
}

function hashStringToU32(str: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// -----------------------------
// RNG
// -----------------------------

class RNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x12345678;
  }

  nextU32(): number {
    // xorshift32
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s;
  }

  next(): number {
    return this.nextU32() / 0xffffffff;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(maxInclusive);
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
}

// -----------------------------
// Math
// -----------------------------

class Vec2 {
  x: number;
  y: number;
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }
  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  add(v: Vec2): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  sub(v: Vec2): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }
  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }
  len(): number {
    return Math.hypot(this.x, this.y);
  }
  lenSq(): number {
    return this.x * this.x + this.y * this.y;
  }
  normalize(): this {
    const l = this.len();
    if (l > 1e-8) {
      this.x /= l;
      this.y /= l;
    }
    return this;
  }
  static fromAngle(rad: number): Vec2 {
    return new Vec2(Math.cos(rad), Math.sin(rad));
  }
}

function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// -----------------------------
// Input
// -----------------------------

class Input {
  private down = new Map<string, boolean>();
  private tapped = new Set<string>();
  private lastPointerDown = false;
  pointerX = 0;
  pointerY = 0;
  pointerDown = false;

  constructor(private element: HTMLElement) {
    const onKeyDown = (e: KeyboardEvent) => {
      const code = e.code;
      if (!this.down.get(code)) this.tapped.add(code);
      this.down.set(code, true);

      // Prevent page scrolling in iframes / browsers
      if (
        code === "Space" ||
        code === "ArrowUp" ||
        code === "ArrowDown" ||
        code === "ArrowLeft" ||
        code === "ArrowRight"
      ) {
        e.preventDefault();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.down.set(e.code, false);
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp, { passive: true });

    const onPointerMove = (e: PointerEvent) => {
      const rect = this.element.getBoundingClientRect();
      this.pointerX = e.clientX - rect.left;
      this.pointerY = e.clientY - rect.top;
    };

    const onPointerDown = (e: PointerEvent) => {
      this.lastPointerDown = this.pointerDown;
      this.pointerDown = true;
      onPointerMove(e);
      // Try to ensure keyboard focus inside iframe
      if (this.element instanceof HTMLCanvasElement) {
        this.element.focus();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      this.pointerDown = false;
      onPointerMove(e);
    };

    this.element.addEventListener("pointermove", onPointerMove, { passive: true });
    this.element.addEventListener("pointerdown", onPointerDown, { passive: true });
    this.element.addEventListener("pointerup", onPointerUp, { passive: true });
    this.element.addEventListener("pointercancel", onPointerUp, { passive: true });
  }

  isDown(code: string): boolean {
    return this.down.get(code) === true;
  }

  wasTapped(code: string): boolean {
    return this.tapped.has(code);
  }

  consumeTap(code: string): boolean {
    if (this.tapped.has(code)) {
      this.tapped.delete(code);
      return true;
    }
    return false;
  }

  justClicked(): boolean {
    // A "click" is pointerDown transitioning from false->true
    const clicked = this.pointerDown && !this.lastPointerDown;
    this.lastPointerDown = this.pointerDown;
    return clicked;
  }

  endFrame(): void {
    this.tapped.clear();
    this.lastPointerDown = this.pointerDown;
  }
}

// -----------------------------
// Host bridge
// -----------------------------

class HostBridge {
  private targetOrigin: string;
  private embedded: boolean;
  private outcomeSent = false;
  private initReceived = false;

  onInit: (config: HostConfig) => void = () => {};

  constructor(private defaultGameId: string) {
    this.embedded = window.parent !== window;
    const origin = window.location.origin;
    // When served via file://, origin is "null"
    this.targetOrigin = origin === "null" ? "*" : origin;

    window.addEventListener("message", (e: MessageEvent) => {
      const d = e.data;
      if (!isPlainObject(d)) return;
      if (d.type !== "init") return;

      const msg = d as HostInitMessage;

      // If embedded, ignore cross-origin init (defense in depth)
      if (this.embedded && this.targetOrigin !== "*" && e.origin !== this.targetOrigin) {
        return;
      }

      const gameId = safeString(msg.gameId, this.defaultGameId);
      const roomIdRaw = msg.roomId;
      const roomId = typeof roomIdRaw === "number" ? String(roomIdRaw) : safeString(roomIdRaw, "");
      const username = safeString(msg.username, "Pilot");
      const allowAbort = safeBoolean(msg.allowAbort, true);
      const seed = seedFromUnknown(msg.seed);

      this.initReceived = true;
      this.onInit({ gameId, roomId, username, allowAbort, seed });
    });

    // Announce ready (host can ignore)
    this.post({ type: "ready", gameId: defaultGameId, version: VERSION } satisfies ReadyMessage);
  }

  get isEmbedded(): boolean {
    return this.embedded;
  }

  get hasInit(): boolean {
    return this.initReceived;
  }

  emitOutcome(outcome: Outcome, payload?: Record<string, unknown>): void {
    if (this.outcomeSent) return;
    this.outcomeSent = true;
    this.post({ type: "outcome", outcome, payload } satisfies OutcomeMessage);
  }

  resetOutcomeLatch(): void {
    this.outcomeSent = false;
  }

  private post(msg: ReadyMessage | OutcomeMessage): void {
    try {
      // If standalone, avoid noisy postMessage loops
      if (window.parent === window) return;
      window.parent.postMessage(msg, this.targetOrigin);
    } catch {
      // Ignore
    }
  }
}

// -----------------------------
// Game entities
// -----------------------------

type ClumpType = "drifter" | "seeker" | "latcher";

type Bullet = {
  pos: Vec2;
  vel: Vec2;
  life: number;
  r: number;
};

type Particle = {
  pos: Vec2;
  vel: Vec2;
  life: number;
  maxLife: number;
  r: number;
  kind: "spark" | "dust" | "thrust";
};

type Clump = {
  id: number;
  type: ClumpType;
  tier: 0 | 1 | 2; // 2 is largest
  pos: Vec2;
  vel: Vec2;
  r: number;

  // visual
  wobbleSeed: number;
  spin: number;

  // latching
  latched: boolean;
  latchAngle: number;
  latchDist: number;
  noLatchT: number; // seconds remaining
};

type Star = {
  x: number;
  y: number;
  r: number;
  tw: number;
  ph: number;
};

// -----------------------------
// Main game
// -----------------------------

class NanobotDriftGame {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 1;
  private h = 1;

  private input: Input;
  private host: HostBridge;

  private config: HostConfig = {
    gameId: GAME_ID_DEFAULT,
    roomId: "",
    username: "Pilot",
    allowAbort: true,
    seed: 0x12345678
  };

  private rng = new RNG(this.config.seed);
  private state: GameState = { kind: "boot" };

  // world
  private t = 0; // seconds since app start
  private runT = 0; // seconds since run start
  private round = 1;

  private empChargesRemaining: number | null = null;

  private shipPos = new Vec2(0, 0);
  private shipVel = new Vec2(0, 0);
  private shipA = 0; // radians

  private assimilation = 0; // 0..100
  private maxAssimilation = 0;
  private beacon = 0; // 0..100
  private score = 0;

  private fireCooldown = 0;
  private empCooldown = 0;
  private empPulseT = 0;

  private bullets: Bullet[] = [];
  private clumps: Clump[] = [];
  private particles: Particle[] = [];

  private stars: Star[] = [];

  private nextClumpId = 1;

  // director
  private spawnTimer = 0;

  // audio
  private muted = false;
  private audioCtx: AudioContext | null = null;

  // ui buttons
  private buttons: {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    label: string;
    enabled: boolean;
    action: () => void;
  }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context not available");
    this.ctx = ctx;

    this.input = new Input(canvas);

    this.host = new HostBridge(GAME_ID_DEFAULT);
    this.host.onInit = (cfg) => {
      this.applyInit(cfg);
    };

    this.resize();
    window.addEventListener("resize", () => this.resize());

    // Standalone param support
    const url = new URL(window.location.href);
    if (url.searchParams.get("standalone") === "1") {
      this.applyInit({
        gameId: url.searchParams.get("gameId") || GAME_ID_DEFAULT,
        roomId: url.searchParams.get("roomId") || "standalone",
        username: url.searchParams.get("username") || "Standalone",
        allowAbort: true,
        seed: seedFromUnknown(url.searchParams.get("seed"))
      });
    }

    // Kick loop
    let last = nowMs();
    const frame = () => {
      const n = nowMs();
      const dt = clamp((n - last) / 1000, 0, 0.05);
      last = n;

      this.update(dt);
      this.render();

      this.input.endFrame();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private applyInit(cfg: HostConfig): void {
    this.config = cfg;
    this.rng = new RNG(cfg.seed);
    this.host.resetOutcomeLatch();

    // Reset to title state (do not auto-start)
    this.state = { kind: "title" };
    this.resetRun(false);
  }

  private configureRound(): void {
    this.empChargesRemaining = this.round >= TOTAL_ROUNDS ? FINAL_ROUND_EMP_CHARGES : null;
  }

  private beaconChargeRate(): number {
    return this.round >= TOTAL_ROUNDS ? BEACON_CHARGE_RATE * FINAL_ROUND_BEACON_MULT : BEACON_CHARGE_RATE;
  }

  private empCooldownMax(): number {
    return EMP_BASE_COOLDOWN + EMP_COOLDOWN_PER_ROUND * (this.round - 1);
  }

  private resetRun(keepTitle: boolean): void {
    this.runT = 0;
    this.score = 0;
    this.assimilation = 0;
    this.maxAssimilation = 0;
    this.beacon = 0;

    this.shipPos.set(this.w * 0.5, this.h * 0.5);
    this.shipVel.set(0, 0);
    this.shipA = -Math.PI / 2;

    this.fireCooldown = 0;
    this.empCooldown = 0;
    this.empPulseT = 0;

    this.bullets = [];
    this.particles = [];
    this.clumps = [];
    this.nextClumpId = 1;

    this.spawnTimer = 0.35;

    // Seed some initial threats
    if (!keepTitle) {
      for (let i = 0; i < 4; i++) this.spawnClump(2, "drifter");
    }
  }

  // -----------------------------
  // Update loop
  // -----------------------------

  private update(dt: number): void {
    this.t += dt;

    // Global toggles
    if (this.input.consumeTap("KeyM")) {
      this.muted = !this.muted;
      // Lazy init audio context on first unmute
      if (!this.muted && !this.audioCtx) {
        try {
          this.audioCtx = new AudioContext();
        } catch {
          // ignore
        }
      }
      this.beep(this.muted ? 160 : 440, 0.05);
    }

    // Pointer click -> UI buttons
    if (this.input.justClicked()) {
      const x = this.input.pointerX;
      const y = this.input.pointerY;
      for (const b of this.buttons) {
        if (!b.enabled) continue;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          b.action();
          break;
        }
      }
    }

    // State machine
    switch (this.state.kind) {
      case "boot": {
        // If no init arrives, user can still start standalone by pressing Enter
        if (this.input.consumeTap("Enter")) {
          this.applyInit({
            gameId: GAME_ID_DEFAULT,
            roomId: "standalone",
            username: "Standalone",
            allowAbort: true,
            seed: seedFromUnknown(undefined)
          });
        }
        break;
      }
      case "title": {
        const start = this.input.consumeTap("Enter") || this.input.consumeTap("Space");
        if (start) {
          this.beginRun();
        }
        break;
      }
      case "paused": {
        if (this.input.consumeTap("Escape") || this.input.consumeTap("Enter")) {
          this.state = { kind: "playing" };
          this.beep(520, 0.03);
        }
        break;
      }
      case "round_complete": {
        break;
      }
      case "result": {
        // In embedded mode, the host will typically transition away.
        // In standalone, require an explicit click on the OK button.
        break;
      }
      case "playing": {
        this.updatePlaying(dt);
        break;
      }
      default: {
        const _exhaustive: never = this.state;
        return _exhaustive;
      }
    }
  }

  private startRound(): void {
    this.resetRun(false);
    this.configureRound();
    this.state = { kind: "playing" };
    this.beep(660, 0.06);
  }

  private beginRun(): void {
    this.round = 1;
    this.startRound();
  }

  private completeRound(): void {
    this.state = { kind: "round_complete" };
    this.beep(520, 0.05);
  }

  private advanceRound(): void {
    this.round = Math.min(this.round + 1, TOTAL_ROUNDS);
    this.startRound();
  }

  private updatePlaying(dt: number): void {
    this.runT += dt;

    // Pause
    if (this.input.consumeTap("Escape")) {
      this.state = { kind: "paused" };
      this.beep(280, 0.03);
      return;
    }

    // Abort from playing (hold to reduce accidental abort)
    if (this.config.allowAbort && (this.input.consumeTap("KeyQ") || this.input.consumeTap("Backspace"))) {
      this.endRun("abort");
      return;
    }

    // Timers
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.empCooldown = Math.max(0, this.empCooldown - dt);
    this.empPulseT = Math.max(0, this.empPulseT - dt);

    // Ship controls
    const rotLeft = this.input.isDown("ArrowLeft") || this.input.isDown("KeyA");
    const rotRight = this.input.isDown("ArrowRight") || this.input.isDown("KeyD");
    const thrust = this.input.isDown("ArrowUp") || this.input.isDown("KeyW");
    const brake = this.input.isDown("ArrowDown") || this.input.isDown("KeyS");

    const rotSpeed = 3.7; // rad/s
    if (rotLeft) this.shipA -= rotSpeed * dt;
    if (rotRight) this.shipA += rotSpeed * dt;

    // Interference: mild drift once heavily assimilated
    const assimN = clamp((this.assimilation - 70) / 30, 0, 1);
    if (assimN > 0) {
      const wob = Math.sin(this.t * 6.2 + this.config.seed * 0.00001) * 0.55;
      this.shipA += wob * assimN * dt * 0.9;
    }

    const forward = Vec2.fromAngle(this.shipA);
    const accel = 260;
    if (thrust) {
      this.shipVel.add(forward.clone().scale(accel * dt));
      this.spawnThrustParticles();
    }

    if (brake) {
      // gentle braking
      this.shipVel.scale(Math.exp(-2.2 * dt));
    }

    // Drag
    this.shipVel.scale(Math.exp(-0.45 * dt));

    // Cap speed
    const maxSpeed = 520;
    const sp = this.shipVel.len();
    if (sp > maxSpeed) {
      this.shipVel.scale(maxSpeed / sp);
    }

    // Integrate ship
    this.shipPos.add(this.shipVel.clone().scale(dt));
    this.shipPos.x = wrap(this.shipPos.x, this.w);
    this.shipPos.y = wrap(this.shipPos.y, this.h);

    // Fire
    const fire = this.input.isDown("Space") || this.input.isDown("KeyJ");
    if (fire && this.fireCooldown <= 0) {
      this.fireCooldown = 0.14;
      this.spawnBullet();
      this.beep(760, 0.02);
    }

    // EMP
    const emp = this.input.consumeTap("KeyE") || this.input.consumeTap("ShiftLeft") || this.input.consumeTap("ShiftRight");
    const empAvailable = this.empChargesRemaining === null || this.empChargesRemaining > 0;
    if (emp && empAvailable && this.empCooldown <= 0) {
      this.empCooldown = this.empCooldownMax();
      this.empPulseT = 0.25;
      this.triggerEmp();
      this.beep(220, 0.08);
      if (this.empChargesRemaining !== null) {
        this.empChargesRemaining = Math.max(0, this.empChargesRemaining - 1);
      }
    }

    // Director spawn
    const difficulty = clamp(this.runT / 90, 0, 1);
    const spawnInterval = lerp(1.75, 0.65, easeOutCubic(difficulty));
    this.spawnTimer -= dt;
    const maxClumps = Math.floor(12 + difficulty * 10);

    while (this.spawnTimer <= 0 && this.freeClumpCount() < maxClumps) {
      this.spawnTimer += spawnInterval;
      const roll = this.rng.next();
      let type: ClumpType = "drifter";
      if (difficulty > 0.25 && roll < 0.25 + difficulty * 0.25) type = "seeker";
      if (difficulty > 0.55 && roll > 0.82) type = "latcher";

      const tier: 0 | 1 | 2 = this.rng.chance(0.35) ? 1 : 2;
      this.spawnClump(tier, type);
    }

    // Update bullets
    for (const b of this.bullets) {
      b.life -= dt;
      b.pos.add(b.vel.clone().scale(dt));
      b.pos.x = wrap(b.pos.x, this.w);
      b.pos.y = wrap(b.pos.y, this.h);
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);

    // Update clumps
    for (const c of this.clumps) {
      if (c.noLatchT > 0) c.noLatchT = Math.max(0, c.noLatchT - dt);

      if (c.latched) {
        // Stay attached
        c.latchAngle += c.spin * dt;
        const off = Vec2.fromAngle(c.latchAngle).scale(c.latchDist);
        c.pos.set(this.shipPos.x + off.x, this.shipPos.y + off.y);
        c.pos.x = wrap(c.pos.x, this.w);
        c.pos.y = wrap(c.pos.y, this.h);
      } else {
        // Mild homing when near
        const toShip = this.shipPos.clone().sub(c.pos);
        // Wrap-aware shortest vector approximation (good enough)
        if (toShip.x > this.w / 2) toShip.x -= this.w;
        if (toShip.x < -this.w / 2) toShip.x += this.w;
        if (toShip.y > this.h / 2) toShip.y -= this.h;
        if (toShip.y < -this.h / 2) toShip.y += this.h;

        const d2 = toShip.lenSq();
        const near = d2 < 420 * 420;
        if (near) {
          const homing = c.type === "drifter" ? 10 : c.type === "seeker" ? 26 : 34;
          toShip.normalize();
          c.vel.add(toShip.scale(homing * dt));
        }

        // Drift
        c.pos.add(c.vel.clone().scale(dt));
        c.pos.x = wrap(c.pos.x, this.w);
        c.pos.y = wrap(c.pos.y, this.h);

        // Slow drift damping
        c.vel.scale(Math.exp(-0.08 * dt));
      }
    }

    // Update particles
    for (const p of this.particles) {
      p.life -= dt;
      p.pos.add(p.vel.clone().scale(dt));
      p.vel.scale(Math.exp(-1.4 * dt));
      p.pos.x = wrap(p.pos.x, this.w);
      p.pos.y = wrap(p.pos.y, this.h);
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    // Collisions: bullet vs free clumps
    for (const b of this.bullets) {
      for (const c of this.clumps) {
        if (c.latched) continue;
        const rr = (b.r + c.r) * (b.r + c.r);
        if (distSq(b.pos, c.pos) <= rr) {
          b.life = 0;
          this.hitClump(c);
          break;
        }
      }
    }

    // Collisions: ship vs free clumps -> latch
    const shipR = 14;
    for (const c of this.clumps) {
      if (c.latched) continue;
      if (c.noLatchT > 0) continue;
      const rr = (shipR + c.r) * (shipR + c.r);
      if (distSq(this.shipPos, c.pos) <= rr) {
        // Attach
        c.latched = true;
        const dx = c.pos.x - this.shipPos.x;
        const dy = c.pos.y - this.shipPos.y;
        c.latchAngle = Math.atan2(dy, dx);
        c.latchDist = shipR + c.r * 0.65;
        // Reduce immediate repeated collisions
        this.shipVel.add(Vec2.fromAngle(c.latchAngle).scale(-45));
        this.beep(180, 0.02);
      }
    }

    // Assimilation / recovery
    const latched = this.latchedClumps();
    let assimRate = 0;
    for (const c of latched) {
      const base = c.type === "drifter" ? 1.8 : c.type === "seeker" ? 2.8 : 4.2;
      const tierMul = c.tier === 2 ? 1.35 : c.tier === 1 ? 1.0 : 0.75;
      assimRate += base * tierMul;
    }

    this.assimilation += assimRate * dt;

    if (latched.length === 0) {
      // Recover slowly when clean
      this.assimilation -= 6.2 * dt;
    }

    // Small passive pressure so you don't camp forever
    if (this.freeClumpCount() > 10 && latched.length === 0) {
      this.assimilation += 0.35 * dt;
    }

    this.assimilation = clamp(this.assimilation, 0, 100);
    this.maxAssimilation = Math.max(this.maxAssimilation, this.assimilation);

    // Win / lose checks
    if (this.assimilation >= 100) {
      this.endRun("lose");
      return;
    }

    if (this.beacon >= 100) {
      if (this.round >= TOTAL_ROUNDS) {
        this.endRun("win");
      } else {
        this.completeRound();
      }
      return;
    }
  }

  private freeClumpCount(): number {
    let n = 0;
    for (const c of this.clumps) if (!c.latched) n++;
    return n;
  }

  private latchedClumps(): Clump[] {
    return this.clumps.filter((c) => c.latched);
  }

  // -----------------------------
  // Spawning
  // -----------------------------

  private spawnBullet(): void {
    const dir = Vec2.fromAngle(this.shipA);
    const speed = 560;
    const b: Bullet = {
      pos: this.shipPos.clone().add(dir.clone().scale(16)),
      vel: this.shipVel.clone().add(dir.scale(speed)),
      life: 1.15,
      r: 2
    };
    this.bullets.push(b);

    // muzzle sparks
    for (let i = 0; i < 6; i++) {
      const ang = this.shipA + this.rng.range(-0.35, 0.35);
      const v = Vec2.fromAngle(ang).scale(this.rng.range(80, 220)).add(this.shipVel.clone().scale(0.25));
      this.spawnParticle(b.pos.clone(), v, 0.25, 1.2, "spark");
    }
  }

  private spawnClump(tier: 0 | 1 | 2, type: ClumpType): void {
    const r = tier === 2 ? 38 : tier === 1 ? 26 : 16;

    // spawn on an edge, away from ship
    for (let attempts = 0; attempts < 10; attempts++) {
      const side = this.rng.int(0, 3);
      let x = 0;
      let y = 0;
      if (side === 0) {
        x = -r;
        y = this.rng.range(0, this.h);
      } else if (side === 1) {
        x = this.w + r;
        y = this.rng.range(0, this.h);
      } else if (side === 2) {
        x = this.rng.range(0, this.w);
        y = -r;
      } else {
        x = this.rng.range(0, this.w);
        y = this.h + r;
      }

      const pos = new Vec2(x, y);
      if (distSq(pos, this.shipPos) < 260 * 260) continue;

      const baseSpeed = this.rng.range(52, 110) * (type === "seeker" ? 1.15 : type === "latcher" ? 1.2 : 1);
      const velAng = this.rng.range(0, Math.PI * 2);
      const vel = Vec2.fromAngle(velAng).scale(baseSpeed);

      const c: Clump = {
        id: this.nextClumpId++,
        type,
        tier,
        pos,
        vel,
        r,
        wobbleSeed: this.rng.nextU32(),
        spin: this.rng.range(-1.2, 1.2),
        latched: false,
        latchAngle: 0,
        latchDist: 0,
        noLatchT: 0
      };

      this.clumps.push(c);
      return;
    }
  }

  private hitClump(c: Clump): void {
    // Score + beacon
    const tierScore = c.tier === 2 ? 120 : c.tier === 1 ? 60 : 30;
    const typeBonus = c.type === "drifter" ? 1 : c.type === "seeker" ? 1.15 : 1.35;
    const gained = Math.floor(tierScore * typeBonus);

    this.score += gained;
    const beaconGain = c.tier === 2 ? 11 : c.tier === 1 ? 6 : 3;
    const beaconBonus = c.type === "latcher" ? 1.25 : c.type === "seeker" ? 1.1 : 1;
    this.beacon = clamp(this.beacon + beaconGain * beaconBonus * this.beaconChargeRate(), 0, 100);

    // Particles
    const n = c.tier === 2 ? 26 : c.tier === 1 ? 18 : 12;
    for (let i = 0; i < n; i++) {
      const ang = this.rng.range(0, Math.PI * 2);
      const sp = this.rng.range(40, 240);
      const v = Vec2.fromAngle(ang).scale(sp).add(c.vel.clone().scale(0.35));
      const kind = this.rng.chance(0.4) ? "spark" : "dust";
      this.spawnParticle(c.pos.clone(), v, this.rng.range(0.35, 0.85), this.rng.range(1.1, 2.4), kind);
    }

    // Split or remove
    if (c.tier > 0) {
      const newTier = (c.tier - 1) as 0 | 1;
      const splitCount = c.tier === 2 ? 2 : 2;
      const baseType: ClumpType = c.type;

      for (let i = 0; i < splitCount; i++) {
        const child: Clump = {
          id: this.nextClumpId++,
          type: baseType,
          tier: newTier,
          pos: c.pos.clone(),
          vel: c.vel
            .clone()
            .add(Vec2.fromAngle(this.rng.range(0, Math.PI * 2)).scale(this.rng.range(40, 160))),
          r: newTier === 1 ? 26 : 16,
          wobbleSeed: this.rng.nextU32(),
          spin: this.rng.range(-1.6, 1.6),
          latched: false,
          latchAngle: 0,
          latchDist: 0,
          noLatchT: 0.25
        };
        this.clumps.push(child);
      }
    }

    // Remove original
    this.clumps = this.clumps.filter((x) => x !== c);

    // Tiny reward: clearing clumps helps you "reframe" (small assimilation reduction)
    this.assimilation = clamp(this.assimilation - 0.8, 0, 100);
  }

  private triggerEmp(): void {
    const radius = 180;

    // Detach all latched clumps, repel nearby free clumps
    for (const c of this.clumps) {
      const d2 = distSq(c.pos, this.shipPos);
      const within = d2 <= radius * radius;

      if (c.latched) {
        c.latched = false;
        c.noLatchT = 0.55;
        const away = c.pos.clone().sub(this.shipPos);
        if (away.len() < 1e-3) away.set(this.rng.range(-1, 1), this.rng.range(-1, 1));
        away.normalize();
        c.vel = this.shipVel.clone().add(away.scale(420));
      } else if (within) {
        const away = c.pos.clone().sub(this.shipPos);
        if (away.len() < 1e-3) away.set(this.rng.range(-1, 1), this.rng.range(-1, 1));
        away.normalize();
        c.vel.add(away.scale(320));
        c.noLatchT = Math.max(c.noLatchT, 0.25);
      }
    }

    // EMP particles ring
    for (let i = 0; i < 44; i++) {
      const ang = (i / 44) * Math.PI * 2;
      const pos = this.shipPos.clone().add(Vec2.fromAngle(ang).scale(radius * 0.85));
      const v = Vec2.fromAngle(ang).scale(this.rng.range(60, 160)).add(this.shipVel.clone().scale(0.15));
      this.spawnParticle(pos, v, this.rng.range(0.25, 0.55), this.rng.range(1.2, 2.3), "spark");
    }

    // Big relief
    this.assimilation = clamp(this.assimilation - 8, 0, 100);
  }

  private spawnParticle(pos: Vec2, vel: Vec2, life: number, r: number, kind: Particle["kind"]): void {
    if (this.particles.length > 380) return;
    this.particles.push({ pos, vel, life, maxLife: life, r, kind });
  }

  private spawnThrustParticles(): void {
    if (this.particles.length > 360) return;

    const back = Vec2.fromAngle(this.shipA + Math.PI);
    const base = this.shipPos.clone().add(back.clone().scale(10));
    for (let i = 0; i < 2; i++) {
      const jitter = Vec2.fromAngle(this.shipA + Math.PI + this.rng.range(-0.7, 0.7)).scale(this.rng.range(18, 52));
      const v = back.clone().scale(this.rng.range(70, 150)).add(jitter).add(this.shipVel.clone().scale(0.2));
      this.spawnParticle(base.clone(), v, this.rng.range(0.16, 0.28), this.rng.range(1.2, 2.2), "thrust");
    }
  }

  // -----------------------------
  // End conditions
  // -----------------------------

  private endRun(outcome: Outcome): void {
    const payload: Record<string, unknown> = {
      score: this.score,
      timeSurvivedMs: Math.round(this.runT * 1000),
      maxAssimilation: Math.round(this.maxAssimilation * 10) / 10,
      beaconCharge: Math.round(this.beacon * 10) / 10,
      seed: this.config.seed,
      version: VERSION
    };

    // Send to host immediately
    this.host.emitOutcome(outcome, payload);

    this.state = { kind: "result", outcome, sent: true };

    // End stinger
    this.beep(outcome === "win" ? 880 : outcome === "lose" ? 120 : 240, 0.12);
  }

  // -----------------------------
  // Rendering
  // -----------------------------

  private render(): void {
    const ctx = this.ctx;

    // Clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(this.dpr, this.dpr);

    // Background
    this.drawBackground();

    // World
    if (this.state.kind !== "boot") {
      this.drawWorld();
    }

    // UI overlays + buttons
    this.buttons = [];
    this.drawUI();

    // If canvas isn't focused (in iframe), hint
    if (document.activeElement !== this.canvas) {
      this.drawFocusHint();
    }

    // Unmute hint
    if (!this.host.isEmbedded && this.muted) {
      this.drawHint("Muted (press M)", this.w - 150, this.h - 22, "right");
    }

    // Reveal fallback if something fails (rare)
    const fallback = document.getElementById("fallback");
    if (fallback) fallback.setAttribute("hidden", "");
  }

  private drawBackground(): void {
    const ctx = this.ctx;

    // Gradient-ish fill
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, this.w, this.h);

    // Stars
    for (const s of this.stars) {
      const tw = 0.55 + 0.45 * Math.sin(this.t * s.tw + s.ph);
      ctx.fillStyle = `rgba(231, 240, 255, ${0.14 * tw})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Subtle vignette
    const g = ctx.createRadialGradient(this.w * 0.5, this.h * 0.5, Math.min(this.w, this.h) * 0.2, this.w * 0.5, this.h * 0.5, Math.max(this.w, this.h) * 0.65);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private drawWorld(): void {
    const ctx = this.ctx;

    // EMP pulse ring
    if (this.empPulseT > 0) {
      const t = 1 - this.empPulseT / 0.25;
      const r = lerp(40, 220, easeOutCubic(t));
      ctx.strokeStyle = `rgba(126, 240, 255, ${0.35 * (1 - t)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.shipPos.x, this.shipPos.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Particles
    for (const p of this.particles) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      if (p.kind === "spark") {
        ctx.fillStyle = `rgba(126, 240, 255, ${0.85 * a})`;
      } else if (p.kind === "thrust") {
        ctx.fillStyle = `rgba(255, 204, 102, ${0.75 * a})`;
      } else {
        ctx.fillStyle = `rgba(231, 240, 255, ${0.22 * a})`;
      }
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bullets
    ctx.fillStyle = "rgba(231, 240, 255, 0.85)";
    for (const b of this.bullets) {
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Clumps (free first, then latched for layering)
    const free = this.clumps.filter((c) => !c.latched);
    const latched = this.clumps.filter((c) => c.latched);

    for (const c of free) this.drawClump(c);
    for (const c of latched) this.drawClump(c);

    // Ship
    this.drawShip();
  }

  private drawClump(c: Clump): void {
    const ctx = this.ctx;
    const t = this.t;

    // Theme colors by type
    const fill = c.type === "drifter" ? "rgba(120, 160, 255, 0.12)" : c.type === "seeker" ? "rgba(126, 240, 255, 0.14)" : "rgba(255, 91, 124, 0.14)";
    const stroke = c.type === "drifter" ? "rgba(120, 160, 255, 0.55)" : c.type === "seeker" ? "rgba(126, 240, 255, 0.65)" : "rgba(255, 91, 124, 0.65)";

    // Irregular blob
    const pts = 14;
    const base = c.r;
    const seed = c.wobbleSeed;

    ctx.save();
    ctx.translate(c.pos.x, c.pos.y);

    // Shadow-ish glow
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let i = 0; i <= pts; i++) {
      const a = (i / pts) * Math.PI * 2;
      const wob = 1 + 0.14 * Math.sin(a * 3 + t * 1.2 + seed * 0.00001);
      const rr = base * wob;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= pts; i++) {
      const a = (i / pts) * Math.PI * 2;
      const wob = 1 + 0.14 * Math.sin(a * 3 + t * 1.2 + seed * 0.00001);
      const rr = base * wob;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Nanobot specks inside
    const specks = c.tier === 2 ? 10 : c.tier === 1 ? 7 : 5;
    for (let i = 0; i < specks; i++) {
      const ph = (seed + i * 2654435761) >>> 0;
      const ang = ((ph % 3600) / 3600) * Math.PI * 2;
      const rr = (0.25 + ((ph >>> 10) % 1000) / 1000 * 0.6) * base * 0.6;
      const x = Math.cos(ang) * rr;
      const y = Math.sin(ang) * rr;
      const tw = 0.35 + 0.65 * Math.sin(t * (0.8 + (ph % 1000) / 1000 * 1.8) + (ph % 100) / 10);
      ctx.fillStyle = c.type === "latcher" ? `rgba(255, 91, 124, ${0.45 * tw})` : `rgba(231, 240, 255, ${0.35 * tw})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Tendrils for latchers
    if (c.type === "latcher") {
      ctx.strokeStyle = "rgba(255, 91, 124, 0.35)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + t * 0.4;
        const rr = base * (1.05 + 0.06 * Math.sin(t * 2 + i));
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        ctx.lineTo(Math.cos(a) * (rr + 10), Math.sin(a) * (rr + 10));
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  private drawShip(): void {
    const ctx = this.ctx;

    const shipR = 14;
    const a = this.shipA;

    const assim = clamp(this.assimilation / 100, 0, 1);

    ctx.save();
    ctx.translate(this.shipPos.x, this.shipPos.y);
    ctx.rotate(a);

    // Outline
    ctx.strokeStyle = "rgba(231, 240, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(shipR, 0);
    ctx.lineTo(-shipR * 0.85, shipR * 0.6);
    ctx.lineTo(-shipR * 0.65, 0);
    ctx.lineTo(-shipR * 0.85, -shipR * 0.6);
    ctx.closePath();
    ctx.stroke();

    // Fill faint
    ctx.fillStyle = "rgba(231, 240, 255, 0.06)";
    ctx.fill();

    // Assimilation corrosion overlay
    if (assim > 0.02) {
      ctx.strokeStyle = `rgba(255, 91, 124, ${0.45 * assim})`;
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 6; i++) {
        const yy = (-0.5 + i / 5) * shipR * 0.9;
        const xx = shipR * (0.2 + 0.12 * Math.sin(this.t * 7 + i));
        ctx.beginPath();
        ctx.moveTo(-shipR * 0.75, yy);
        ctx.lineTo(xx, yy + Math.sin(this.t * 5 + i) * 2);
        ctx.stroke();
      }
    }

    // Nose light
    ctx.fillStyle = "rgba(126, 240, 255, 0.6)";
    ctx.beginPath();
    ctx.arc(shipR * 0.72, 0, 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Outer shield ring hint when EMP ready
    if (this.empCooldown <= 0.01) {
      ctx.strokeStyle = "rgba(126, 240, 255, 0.12)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.shipPos.x, this.shipPos.y, 26, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawUI(): void {
    const ctx = this.ctx;

    // HUD base
    if (
      this.state.kind === "playing" ||
      this.state.kind === "paused" ||
      this.state.kind === "result" ||
      this.state.kind === "round_complete"
    ) {
      this.drawHUD();
    }

    // Overlay per state
    if (this.state.kind === "boot") {
      this.drawCenterPanel({
        title: "Nanobot Drift",
        body: [
          this.host.hasInit ? "Initializing…" : "Waiting for host init…",
          "",
          "If you're running this standalone:",
          "- press Enter to start in standalone mode",
          "- or add ?standalone=1 to the URL"
        ],
        footer: `v${VERSION}`
      });
      return;
    }

    if (this.state.kind === "title") {
      this.drawTitle();
      return;
    }

    if (this.state.kind === "paused") {
      this.drawPauseMenu();
      return;
    }

    if (this.state.kind === "round_complete") {
      this.drawRoundComplete();
      return;
    }

    if (this.state.kind === "result") {
      this.drawResult();
      return;
    }
  }

  private drawHUD(): void {
    const ctx = this.ctx;

    // Top-left: score
    ctx.font = "600 16px ui-sans-serif, system-ui";
    ctx.fillStyle = "rgba(231, 240, 255, 0.9)";
    ctx.textAlign = "left";
    ctx.fillText(`Score: ${this.score}`, 16, 24);

    // Top-right: time
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(231, 240, 255, 0.75)";
    ctx.fillText(formatTime(this.runT), this.w - 16, 24);

    // Username
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(231, 240, 255, 0.55)";
    const name = this.config.username ? this.config.username : "Pilot";
    ctx.fillText(name, 16, 44);

    // Bars
    const barW = Math.min(360, this.w - 32);
    const barH = 14;

    // Assimilation
    const ax = 16;
    const ay = this.h - 54;
    this.drawBar(ax, ay, barW, barH, this.assimilation / 100, "Assimilation", "danger");

    // Beacon
    const bx = 16;
    const by = this.h - 32;
    this.drawBar(bx, by, barW, barH, this.beacon / 100, "Beacon Charge", "accent");

    // EMP cooldown circle
    const cd = this.empCooldown;
    const cdMax = this.empCooldownMax();
    const ready = cd <= 0.01;
    const empLimited = this.empChargesRemaining !== null;
    const empExhausted = empLimited && (this.empChargesRemaining ?? 0) <= 0;

    const cx = this.w - 52;
    const cy = this.h - 42;
    const r = 22;

    ctx.strokeStyle = "rgba(231, 240, 255, 0.18)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    if (empExhausted) {
      ctx.strokeStyle = "rgba(231, 240, 255, 0.12)";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = "rgba(231, 240, 255, 0.35)";
      ctx.font = "700 11px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.fillText("EMP 0", cx, cy + 4);
    } else if (ready) {
      ctx.strokeStyle = "rgba(126, 240, 255, 0.65)";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(126, 240, 255, 0.8)";
      ctx.font = "700 12px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.fillText("EMP", cx, cy + 4);
    } else {
      const p = clamp(1 - cd / cdMax, 0, 1);
      ctx.strokeStyle = "rgba(126, 240, 255, 0.55)";
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      ctx.stroke();

      ctx.fillStyle = "rgba(231, 240, 255, 0.65)";
      ctx.font = "700 12px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.fillText(`${Math.ceil(cd)}`, cx, cy + 4);
    }

    if (empLimited) {
      ctx.fillStyle = "rgba(231, 240, 255, 0.5)";
      ctx.font = "600 10px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.fillText(`${this.empChargesRemaining} left`, cx, cy + 24);
    }

    // Tiny help hint
    if (this.runT < 8 && this.state.kind === "playing") {
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(231, 240, 255, 0.45)";
      ctx.font = "500 13px ui-sans-serif, system-ui";
      ctx.fillText("WASD/Arrows • Space: fire • E/Shift: EMP • Esc: pause", this.w - 16, 44);
    }
  }

  private drawBar(x: number, y: number, w: number, h: number, p: number, label: string, tone: "danger" | "accent"): void {
    const ctx = this.ctx;
    const pp = clamp(p, 0, 1);

    ctx.fillStyle = "rgba(10, 14, 20, 0.65)";
    ctx.fillRect(x, y, w, h);

    const col = tone === "danger" ? "rgba(255, 91, 124, 0.85)" : "rgba(126, 240, 255, 0.85)";
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w * pp, h);

    ctx.strokeStyle = "rgba(231, 240, 255, 0.14)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);

    ctx.font = "600 12px ui-sans-serif, system-ui";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(231, 240, 255, 0.85)";
    ctx.fillText(label, x + 8, y + h - 3);

    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(231, 240, 255, 0.65)";
    ctx.fillText(`${Math.round(pp * 100)}%`, x + w - 8, y + h - 3);
  }

  private drawTitle(): void {
    const body = [
      "Out-of-control human nanobots have context-shifted… hard.",
      "They now believe your ship must be 'helpfully assimilated'.",
      "",
      "Hold them off and charge the containment beacon.",
      "",
      "Controls:",
      "- Rotate: A/D or Left/Right",
      "- Thrust: W or Up",
      "- Fire: Space",
      "- EMP Burst: E or Shift",
      "- Pause: Esc",
      this.config.allowAbort ? "- Quit Nanobot Drift and return to room: Q (or Backspace)" : ""
    ].filter((s) => s.length > 0);

    this.drawCenterPanel({
      title: "Nanobot Drift",
      body,
      footer: this.host.isEmbedded
        ? "Press Enter to start"
        : "Press Enter to start • (Standalone: press M to toggle sound)",
      badge: `seed ${this.config.seed}`
    });

    // Start button (click)
    const bw = 220;
    const bh = 42;
    const bx = this.w * 0.5 - bw * 0.5;
    const by = this.h * 0.5 + 165;
    this.drawButton("start", bx, by, bw, bh, "Start", true, () => this.beginRun());
  }

  private drawPauseMenu(): void {
    const body = [
      "Paused.",
      "",
      "Press Esc or Enter to resume.",
      this.config.allowAbort ? "Press Q to quit Nanobot Drift and return to room." : ""
    ].filter((s) => s.length > 0);

    this.drawCenterPanel({ title: "Paused", body, footer: "" });

    const bw = 220;
    const bh = 42;
    const bx = this.w * 0.5 - bw * 0.5;
    const by = this.h * 0.5 + 110;
    this.drawButton("resume", bx, by, bw, bh, "Resume", true, () => {
      this.state = { kind: "playing" };
      this.beep(520, 0.03);
    });

    if (this.config.allowAbort) {
      this.drawButton("abort", bx, by + 54, bw, bh, "Abort", true, () => this.endRun("abort"));
    }

    if (!this.host.isEmbedded) {
      this.drawButton("restart", bx, by + (this.config.allowAbort ? 108 : 54), bw, bh, "Restart", true, () => {
        this.state = { kind: "title" };
        this.resetRun(true);
      });
    }
  }

  private drawRoundComplete(): void {
    const nextRound = this.round + 1;
    const body = [
      "Nice work, pilot.",
      `Round ${this.round} of ${TOTAL_ROUNDS} complete.`,
      "",
      `Get ready for Round ${nextRound}.`,
      "You've got this."
    ];

    this.drawCenterPanel({
      title: `Round ${this.round} Complete`,
      body,
      footer: "Click Next Round to continue",
      badge: `v${VERSION}`
    });

    const bw = 220;
    const bh = 42;
    const bx = this.w * 0.5 - bw * 0.5;
    const by = this.h * 0.5 + 140;
    this.drawButton("next-round", bx, by, bw, bh, "Next Round", true, () => {
      this.advanceRound();
    });
  }

  private drawResult(): void {
    const outcome = this.state.kind === "result" ? this.state.outcome : "lose";

    const title = outcome === "win" ? "Beacon Fired" : outcome === "lose" ? "Assimilated" : "Aborted";

    const body: string[] = [];
    if (outcome === "win") {
      body.push(
        "You broadcast the universal reframe signal.",
        "The swarms hesitate… then drift away.",
        "",
        `Round ${this.round} of ${TOTAL_ROUNDS} complete.`,
        "All rounds cleared. Outstanding work."
      );
    } else if (outcome === "lose") {
      body.push("The swarm finishes integrating your ship.", "Somewhere, a thousand tiny models celebrate.");
    } else {
      body.push("You cut thrusters and retreat.");
    }

    body.push("", `Score: ${this.score}`, `Time: ${formatTime(this.runT)}`, `Max assimilation: ${Math.round(this.maxAssimilation)}%`);

    this.drawCenterPanel({
      title,
      body,
      footer: this.host.isEmbedded ? "Outcome sent to host" : "Click OK to return to title",
      badge: `v${VERSION}`
    });

    if (!this.host.isEmbedded) {
      const bw = 220;
      const bh = 42;
      const bx = this.w * 0.5 - bw * 0.5;
      const by = this.h * 0.5 + 140;
      this.drawButton("ok", bx, by, bw, bh, "OK", true, () => {
        this.state = { kind: "title" };
        this.resetRun(true);
      });
    }
  }

  private drawCenterPanel(opts: { title: string; body: string[]; footer: string; badge?: string }): void {
    const ctx = this.ctx;

    // Dim backdrop
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, this.w, this.h);

    const pad = 18;
    const pw = Math.min(560, this.w - 28);
    const x = this.w * 0.5 - pw * 0.5;
    const y = this.h * 0.5 - 190;

    // Panel
    ctx.fillStyle = "rgba(10, 14, 20, 0.86)";
    ctx.strokeStyle = "rgba(231, 240, 255, 0.16)";
    ctx.lineWidth = 1;
    const ph = 340;
    roundRect(ctx, x, y, pw, ph, 14);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.font = "800 28px ui-sans-serif, system-ui";
    ctx.fillStyle = "rgba(231, 240, 255, 0.92)";
    ctx.textAlign = "left";
    ctx.fillText(opts.title, x + pad, y + 44);

    // Badge
    if (opts.badge) {
      ctx.font = "600 12px ui-sans-serif, system-ui";
      ctx.fillStyle = "rgba(231, 240, 255, 0.55)";
      ctx.textAlign = "right";
      ctx.fillText(opts.badge, x + pw - pad, y + 44);
    }

    // Body
    ctx.font = "500 15px ui-sans-serif, system-ui";
    ctx.fillStyle = "rgba(231, 240, 255, 0.78)";
    ctx.textAlign = "left";
    let yy = y + 76;
    for (const line of opts.body) {
      ctx.fillText(line, x + pad, yy);
      yy += 20;
    }

    // Footer
    if (opts.footer) {
      ctx.font = "600 14px ui-sans-serif, system-ui";
      ctx.fillStyle = "rgba(126, 240, 255, 0.75)";
      ctx.textAlign = "left";
      ctx.fillText(opts.footer, x + pad, y + ph - 18);
    }
  }

  private drawButton(id: string, x: number, y: number, w: number, h: number, label: string, enabled: boolean, action: () => void): void {
    const ctx = this.ctx;

    const hovered = this.input.pointerX >= x && this.input.pointerX <= x + w && this.input.pointerY >= y && this.input.pointerY <= y + h;

    ctx.fillStyle = enabled
      ? hovered
        ? "rgba(126, 240, 255, 0.18)"
        : "rgba(126, 240, 255, 0.12)"
      : "rgba(231, 240, 255, 0.08)";
    ctx.strokeStyle = enabled ? "rgba(126, 240, 255, 0.45)" : "rgba(231, 240, 255, 0.18)";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();

    ctx.font = "800 15px ui-sans-serif, system-ui";
    ctx.fillStyle = enabled ? "rgba(231, 240, 255, 0.9)" : "rgba(231, 240, 255, 0.4)";
    ctx.textAlign = "center";
    ctx.fillText(label, x + w * 0.5, y + h * 0.65);

    this.buttons.push({ id, x, y, w, h, label, enabled, action });
  }

  private drawFocusHint(): void {
    // Not too spammy; only when playing-ish
    if (this.state.kind !== "playing" && this.state.kind !== "title") return;
    this.drawHint("Click to focus", this.w * 0.5, 18, "center");
  }

  private drawHint(text: string, x: number, y: number, align: "left" | "center" | "right"): void {
    const ctx = this.ctx;
    ctx.font = "600 12px ui-sans-serif, system-ui";
    ctx.textAlign = align;
    ctx.fillStyle = "rgba(231, 240, 255, 0.45)";
    ctx.fillText(text, x, y);
  }

  // -----------------------------
  // Audio
  // -----------------------------

  private beep(freq: number, durationS: number): void {
    if (this.muted) return;
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = "triangle";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.02, durationS));

    o.connect(g);
    g.connect(ctx.destination);

    o.start(t0);
    o.stop(t0 + Math.max(0.02, durationS) + 0.02);
  }

  // -----------------------------
  // Resize
  // -----------------------------

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));

    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);

    // Recenter ship if needed
    if (this.shipPos.x === 0 && this.shipPos.y === 0) {
      this.shipPos.set(this.w * 0.5, this.h * 0.5);
    } else {
      // Keep within bounds
      this.shipPos.x = clamp(this.shipPos.x, 0, this.w);
      this.shipPos.y = clamp(this.shipPos.y, 0, this.h);
    }

    // Regenerate starfield
    this.regenStars();
  }

  private regenStars(): void {
    const r = new RNG(this.config.seed ^ 0x9e3779b9);
    const count = Math.floor(clamp((this.w * this.h) / 12000, 80, 180));
    this.stars = [];
    for (let i = 0; i < count; i++) {
      this.stars.push({
        x: r.range(0, this.w),
        y: r.range(0, this.h),
        r: r.range(0.6, 1.6),
        tw: r.range(0.4, 2.2),
        ph: r.range(0, Math.PI * 2)
      });
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// -----------------------------
// Bootstrap
// -----------------------------

function main(): void {
  const canvas = document.getElementById("game");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element #game not found");
  }

  // Focus on first click
  canvas.addEventListener(
    "pointerdown",
    () => {
      canvas.focus();
    },
    { passive: true }
  );

  // Prevent context menu on right click inside iframe
  canvas.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
    },
    { passive: false }
  );

  // eslint-disable-next-line no-new
  new NanobotDriftGame(canvas);
}

main();
