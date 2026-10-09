import { Camera, lerpCamera, type CameraState, type ScreenRect, type WorldRect } from './gl/camera';
import { Renderer } from './gl/renderer';
import { FlapOpener, flapCorner, foldPose } from './sim/fold';
import { computeNormals, PaperSim, type Grab } from './sim/paper';

export type Phase = 'empty' | 'folding' | 'folded' | 'open';

/** Screen space (CSS px) the UI keeps for itself around the paper. */
export interface Insets {
  top: number;
  bottom: number;
  side: number;
}

interface Finger {
  grab: Grab;
  x: number;
  y: number;
  /** Recent samples (time ms, x, y) for a smooth release velocity. */
  trail: [number, number, number][];
  startX: number;
  startY: number;
  startTime: number;
  baseY: number;
  moved: boolean;
}

interface CameraTween {
  from: CameraState;
  to: CameraState;
  t: number;
  duration: number;
}

const LIFT = 0.11;
const TAP_MS = 320;
const TAP_PX = 9;
const OPEN_ENOUGH = 0.7;

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/** Pick a grid size the device can simulate comfortably (cached per device). */
function chooseGrid(): [number, number] {
  const key = 'nicenotes:grid:v2';
  try {
    const cached = localStorage.getItem(key);
    if (cached) {
      const [a, b] = cached.split('x').map(Number);
      if (a > 0 && b > 0 && a % 2 === 0 && b % 2 === 0) return [a, b];
    }
  } catch {
    // Storage can be unavailable (private mode); just measure.
  }
  const sim = new PaperSim(24, 30);
  const pose = new Float32Array(sim.n * 3);
  foldPose(sim, Math.PI, Math.PI, pose);
  sim.adoptPose(pose, true);
  const opener = new FlapOpener(sim, 1, 0.4);
  for (let i = 0; i < 5; i++) {
    opener.update(1 / 60);
    sim.step(1 / 60);
  }
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    opener.update(1 / 60);
    sim.step(1 / 60);
  }
  const ms = (performance.now() - t0) / 10;
  // Fold lines must fall on grid lines, so both counts stay even.
  const grid: [number, number] = ms < 6 ? [24, 30] : [16, 20];
  try {
    localStorage.setItem(key, grid.join('x'));
  } catch {
    // Fine: we'll measure again next time.
  }
  return grid;
}

export class Scene {
  readonly canvas: HTMLCanvasElement;
  readonly camera = new Camera();
  readonly sim: PaperSim;
  phase: Phase = 'empty';
  insets: Insets = { top: 72, bottom: 150, side: 18 };
  /** Called when the phase changes. */
  onPhase: ((phase: Phase) => void) | null = null;
  /** Called the first time someone touches the paper. */
  onTouch: (() => void) | null = null;
  reducedMotion = false;

  private renderer: Renderer;
  private readonly renderNormals: Float32Array;
  private readonly uvs: Float32Array;
  private readonly sides: Float32Array;
  private readonly scratch: Float32Array;
  private front: TexImageSource | null = null;
  private back: TexImageSource | null = null;
  private crease: [number, number] = [0, 0];
  private creaseGoal: [number, number] = [0, 0];
  private fingers = new Map<number, Finger>();
  private opener: FlapOpener | null = null;
  private openQueue: (0 | 1)[] = [];
  private openPause = 0;
  private tween: CameraTween | null = null;
  private framing: 'home' | 'note' | 'custom' = 'home';
  private fold: { t: number; done: () => void } | null = null;
  private raf = 0;
  private lastTime = 0;
  private needsDraw = true;
  private scale = Math.min(2, window.devicePixelRatio || 1);
  private slowTime = 0;
  private activeTime = 0;
  private hintTimeout = 0;
  private touched = false;
  private lost = false;
  private paused = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    const [nx, nz] = chooseGrid();
    this.sim = new PaperSim(nx, nz);
    this.renderNormals = new Float32Array(this.sim.n * 3);
    this.scratch = new Float32Array(this.sim.n * 3);
    this.uvs = new Float32Array(this.sim.n * 2);
    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) {
        const i = this.sim.idx(ix, iz);
        this.uvs[i * 2] = ix / nx;
        this.uvs[i * 2 + 1] = iz / nz;
      }
    }
    // Which half each vertex is in; fold lines count as the side that ends up
    // outermost (top half for fold A, right half for fold B).
    this.sides = new Float32Array(this.sim.n * 2);
    for (let i = 0; i < this.sim.n; i++) {
      this.sides[i * 2] = this.sim.restZ[i] < 1e-6 ? 1 : 0;
      this.sides[i * 2 + 1] = this.sim.restX[i] > -1e-6 ? 1 : 0;
    }
    this.renderer.setMesh(this.sim.n, this.uvs, this.sides, this.sim.indices);

    type Events = HTMLElementEventMap & { webglcontextlost: Event; webglcontextrestored: Event };
    const on = <K extends keyof Events>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: Events[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(canvas, 'pointerdown', (e) => this.pointerDown(e));
    on(canvas, 'pointermove', (e) => this.pointerMove(e));
    on(canvas, 'pointerup', (e) => this.pointerUp(e, false));
    on(canvas, 'pointercancel', (e) => this.pointerUp(e, true));
    on(canvas, 'lostpointercapture', (e) => this.pointerUp(e, true));
    on(canvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    });
    on(canvas, 'webglcontextrestored', () => {
      this.lost = false;
      this.renderer = new Renderer(canvas);
      this.renderer.setMesh(this.sim.n, this.uvs, this.sides, this.sim.indices);
      if (this.front && this.back) this.renderer.setTextures(this.front, this.back);
      this.resize();
    });
    on(window, 'resize', () => this.resize());
    this.resize();
  }

  // ---------------------------------------------------------------- setup

  setTextures(front: TexImageSource, back: TexImageSource): void {
    this.front = front;
    this.back = back;
    this.renderer.setTextures(front, back);
    this.invalidate();
  }

  /** Size of the paper on the table, in world units. */
  get paperRect(): WorldRect {
    const { width, height } = this.sim;
    return { x0: -width / 2, z0: -height / 2, x1: width / 2, z1: height / 2 };
  }

  private safeRect(): ScreenRect {
    const { top, bottom, side } = this.insets;
    const w = this.camera.width;
    const h = this.camera.height;
    return { left: side, top, width: Math.max(40, w - side * 2), height: Math.max(40, h - top - bottom) };
  }

  private homeCamera(): CameraState {
    const pad = 0.04;
    const r = this.paperRect;
    return this.camera.fit({ x0: r.x0 - pad, z0: r.z0 - pad, x1: r.x1 + pad, z1: r.z1 + pad }, this.safeRect());
  }

  /** Close-up on the folded note (it sits in the paper's bottom-left quarter). */
  private noteCamera(): CameraState {
    const { width, height } = this.sim;
    const safe = this.safeRect();
    // Show the note about 3/5 of the safe width, a little above centre.
    const noteW = width / 2;
    const scale = Math.min((safe.width * 0.6) / noteW, (safe.height * 0.55) / (height / 2));
    const w = safe.width / scale;
    const h = safe.height / scale;
    const cx = -width / 4;
    const cz = height / 4 + h * 0.04;
    return this.camera.fit({ x0: cx - w / 2, z0: cz - h / 2, x1: cx + w / 2, z1: cz + h / 2 }, safe);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.setViewport(w, h);
    this.renderer.resize(w, h, this.scale);
    if (this.framing !== 'custom' && !this.tween) {
      this.camera.state = this.framing === 'home' ? this.homeCamera() : this.noteCamera();
    } else if (this.tween) {
      this.tween.to = this.framing === 'note' ? this.noteCamera() : this.homeCamera();
    }
    // A far-away safety net; keepInView() does the gentle work.
    const v = this.camera.visibleTable(this.homeCamera());
    const m = 0.6;
    this.sim.bounds = { minX: v.x0 - m, maxX: v.x1 + m, minZ: v.z0 - m, maxZ: v.z1 + m };
    this.invalidate();
  }

  private moveCamera(to: 'home' | 'note', duration = 0.75): void {
    this.framing = to;
    const target = to === 'home' ? this.homeCamera() : this.noteCamera();
    if (this.reducedMotion) {
      this.camera.state = target;
      this.tween = null;
    } else {
      this.tween = { from: { ...this.camera.state }, to: target, t: 0, duration };
    }
    this.invalidate();
  }

  private setPhase(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.onPhase?.(phase);
  }

  // ------------------------------------------------------------- sequences

  /**
   * Sender: start flat exactly over `rect` (the DOM card), then fold the note
   * up and zoom in on it. Resolves once it's folded.
   */
  foldFrom(rect: ScreenRect): Promise<void> {
    this.sim.reset();
    this.crease = [0, 0];
    this.creaseGoal = [0, 0];
    this.touched = false;
    this.framing = 'custom';
    this.tween = null;
    this.camera.state = this.camera.fit(this.paperRect, rect);
    this.setPhase('folding');
    return new Promise((done) => {
      this.fold = { t: 0, done };
      this.invalidate();
    });
  }

  /** Receiver: a folded note, dropped gently onto the table. */
  presentFolded(): void {
    foldPose(this.sim, Math.PI, Math.PI, this.scratch);
    if (!this.reducedMotion) {
      for (let i = 1; i < this.scratch.length; i += 3) this.scratch[i] += 0.2;
    }
    this.sim.adoptPose(this.scratch, true);
    this.crease = [1, 1];
    this.creaseGoal = [1, 1];
    this.touched = false;
    this.framing = 'note';
    this.tween = null;
    this.camera.state = this.noteCamera();
    this.setPhase('folded');
    this.invalidate();
  }

  /** Open whatever is still folded, one flap after the other. */
  openAll(): void {
    if (this.phase !== 'folded' || this.opener || this.openQueue.length) return;
    this.firstTouch();
    if (this.sim.creaseOpenness(1) < OPEN_ENOUGH) this.openQueue.push(1);
    if (this.sim.creaseOpenness(0) < OPEN_ENOUGH) this.openQueue.push(0);
    this.openPause = 0.05;
    this.invalidate();
  }

  // ----------------------------------------------------------------- input

  private localPoint(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** The particle under a screen point: ray-cast the mesh, else the nearest edge. */
  private pick(px: number, py: number): number | null {
    const [ox, oy, oz, dx, dy, dz] = this.camera.ray(px, py);
    const p = this.sim.pos;
    const idx = this.sim.indices;
    let best = Infinity;
    let bestTri = -1;
    let bu = 0;
    let bv = 0;
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3;
      const b = idx[k + 1] * 3;
      const c = idx[k + 2] * 3;
      const e1x = p[b] - p[a];
      const e1y = p[b + 1] - p[a + 1];
      const e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a];
      const e2y = p[c + 1] - p[a + 1];
      const e2z = p[c + 2] - p[a + 2];
      const hx = dy * e2z - dz * e2y;
      const hy = dz * e2x - dx * e2z;
      const hz = dx * e2y - dy * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const sx = ox - p[a];
      const sy = oy - p[a + 1];
      const sz = oz - p[a + 2];
      const u = (sx * hx + sy * hy + sz * hz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 0 && t < best) {
        best = t;
        bestTri = k;
        bu = u;
        bv = v;
      }
    }
    if (bestTri >= 0) {
      const w = [1 - bu - bv, bu, bv];
      const j = w.indexOf(Math.max(...w));
      return idx[bestTri + j];
    }
    // Missed: accept a touch just off the paper's edge (fat fingers).
    let near = -1;
    let nearD = 26 * 26;
    for (let i = 0; i < this.sim.n; i++) {
      const [sx, sy] = this.camera.project(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < nearD - 1e-6 || (near >= 0 && Math.abs(d - nearD) < 4 && p[i * 3 + 1] > p[near * 3 + 1])) {
        nearD = d;
        near = i;
      }
    }
    return near >= 0 ? near : null;
  }

  private firstTouch(): void {
    if (this.touched) return;
    this.touched = true;
    if (this.framing === 'note') this.moveCamera('home', 0.7);
    this.onTouch?.();
  }

  private pointerDown(e: PointerEvent): void {
    if (this.phase !== 'folded' && this.phase !== 'open') return;
    if (this.opener || this.openQueue.length || this.fingers.size >= 2) return;
    const [x, y] = this.localPoint(e);
    const particle = this.pick(x, y);
    if (particle === null) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const grab = this.sim.grab(particle);
    this.fingers.set(e.pointerId, {
      grab,
      x,
      y,
      startX: x,
      startY: y,
      startTime: performance.now(),
      baseY: this.sim.pos[particle * 3 + 1],
      moved: false,
      trail: [[performance.now(), x, y]],
    });
    this.firstTouch();
    this.invalidate();
  }

  private pointerMove(e: PointerEvent): void {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    const [x, y] = this.localPoint(e);
    f.x = x;
    f.y = y;
    const now = performance.now();
    f.trail.push([now, x, y]);
    while (f.trail.length > 2 && now - f.trail[0][0] > 120) f.trail.shift();
    if (Math.hypot(x - f.startX, y - f.startY) > TAP_PX) f.moved = true;
    this.invalidate();
  }

  private pointerUp(e: PointerEvent, cancelled: boolean): void {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    this.sim.release(f.grab, 2.2, this.flingVelocity(f));
    const tap = !cancelled && !f.moved && performance.now() - f.startTime < TAP_MS;
    if (tap && this.phase === 'folded') this.openAll();
    this.invalidate();
  }

  /** The finger's recent velocity, on the table, in world units per second. */
  private flingVelocity(f: Finger): [number, number, number] {
    const now = performance.now();
    const recent = f.trail.filter(([t]) => now - t < 90);
    if (recent.length < 2) return [0, 0, 0];
    const [t0, x0, y0] = recent[0];
    const [t1, x1, y1] = recent[recent.length - 1];
    const dt = Math.max(16, t1 - t0) / 1000;
    const h = this.sim.pos[f.grab.particle * 3 + 1];
    const [ax, az] = this.camera.onPlane(x0, y0, h);
    const [bx, bz] = this.camera.onPlane(x1, y1, h);
    // A little less than the finger: paper is light and air slows it at once.
    return [((bx - ax) / dt) * 0.6, 0, ((bz - az) / dt) * 0.6];
  }

  /** If the sheet has wandered off screen, glide it gently back into view. */
  private keepInView(dt: number): boolean {
    if (this.fingers.size || this.opener || this.fold) return false;
    const view = this.camera.visibleTable(this.homeCamera());
    const p = this.sim.pos;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let o = 0; o < p.length; o += 3) {
      x0 = Math.min(x0, p[o]);
      x1 = Math.max(x1, p[o]);
      z0 = Math.min(z0, p[o + 2]);
      z1 = Math.max(z1, p[o + 2]);
    }
    const m = 0.03;
    const push = (lo: number, hi: number, vlo: number, vhi: number) => {
      if (hi - lo > vhi - vlo - 2 * m) return (vlo + vhi) / 2 - (lo + hi) / 2;
      if (lo < vlo + m) return vlo + m - lo;
      if (hi > vhi - m) return vhi - m - hi;
      return 0;
    };
    const dx = push(x0, x1, view.x0, view.x1);
    const dz = push(z0, z1, view.z0, view.z1);
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return false;
    const k = 1 - Math.exp(-dt * 4);
    this.sim.translate(dx * k, dz * k);
    return true;
  }

  // ------------------------------------------------------------------ loop

  /** Make sure a frame gets drawn (and the loop runs while things move). */
  invalidate(): void {
    this.needsDraw = true;
    clearTimeout(this.hintTimeout);
    if (!this.raf && !this.lost && !this.paused) {
      this.lastTime = -1;
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  private frame(now: number): void {
    this.raf = 0;
    // The first frame after a pause has no previous one: assume a normal frame.
    const rawDt = this.lastTime < 0 ? 1 / 60 : (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0), 1 / 24);
    let busy = false;

    // Sender's folding animation (kinematic).
    if (this.fold) {
      busy = true;
      this.fold.t += dt * (this.reducedMotion ? 1.6 : 1);
      const t = this.fold.t;
      const aStart = 0.45;
      const aEnd = aStart + 0.95;
      const bStart = aEnd + 0.12;
      const bEnd = bStart + 0.9;
      const thetaA = Math.PI * easeInOut(Math.min(1, Math.max(0, (t - aStart) / (aEnd - aStart))));
      const thetaB = Math.PI * easeInOut(Math.min(1, Math.max(0, (t - bStart) / (bEnd - bStart))));
      foldPose(this.sim, thetaA, thetaB, this.scratch);
      this.sim.pos.set(this.scratch);
      if (t >= aEnd) this.creaseGoal[0] = 1;
      if (t >= bStart + 0.35 && this.framing === 'custom') this.moveCamera('note', 1.1);
      if (t >= bEnd) {
        this.sim.adoptPose(this.scratch, true);
        this.creaseGoal = [1, 1];
        const done = this.fold.done;
        this.fold = null;
        this.setPhase('folded');
        done();
      }
    }

    // Tap-to-open "virtual hand".
    if (this.opener) {
      busy = true;
      if (this.opener.update(dt)) {
        this.opener = null;
        this.openPause = 0.18;
      }
    } else if (this.openQueue.length) {
      busy = true;
      this.openPause -= dt;
      if (this.openPause <= 0) {
        const line = this.openQueue.shift()!;
        if (this.sim.creaseOpenness(line) < OPEN_ENOUGH) {
          this.opener = new FlapOpener(this.sim, line, this.reducedMotion ? 0.6 : 0.95);
        }
      }
    }

    // Fingers: lift what's held a little, and follow the finger on screen.
    for (const f of this.fingers.values()) {
      busy = true;
      const age = (performance.now() - f.startTime) / 1000;
      const lift = f.baseY + LIFT * easeInOut(Math.min(1, age / 0.16));
      const [x, z] = this.camera.onPlane(f.x, f.y, lift);
      this.sim.moveGrab(f.grab, x, lift, z);
    }

    // Camera.
    if (this.tween) {
      busy = true;
      this.tween.t += dt;
      const u = Math.min(1, this.tween.t / this.tween.duration);
      this.camera.state = lerpCamera(this.tween.from, this.tween.to, easeInOut(u));
      if (u >= 1) this.tween = null;
    }

    // Crease lines fade in once folded.
    for (let k = 0; k < 2; k++) {
      if (this.crease[k] !== this.creaseGoal[k]) {
        busy = true;
        const d = this.creaseGoal[k] - this.crease[k];
        this.crease[k] += Math.sign(d) * Math.min(Math.abs(d), dt * 2.5);
      }
    }

    if (this.phase === 'open' || this.phase === 'folded') busy = this.keepInView(dt) || busy;
    const simmed = !this.fold && this.sim.step(dt);
    busy ||= simmed;

    // Notice when the note has been opened up.
    if (this.phase === 'folded' && !this.opener && !this.openQueue.length && simmed) {
      if (this.sim.creaseOpenness(0) > OPEN_ENOUGH && this.sim.creaseOpenness(1) > OPEN_ENOUGH) {
        this.setPhase('open');
      }
    }

    if (busy || this.needsDraw) this.draw();
    this.needsDraw = false;
    this.adaptQuality(rawDt, busy);

    if (busy) {
      this.raf = requestAnimationFrame((t) => this.frame(t));
    } else {
      this.scheduleHint();
    }
  }

  /** While the note sits folded, a gentle flutter now and then says "I open". */
  private scheduleHint(): void {
    clearTimeout(this.hintTimeout);
    if (this.phase !== 'folded' || this.reducedMotion) return;
    this.hintTimeout = window.setTimeout(
      () => {
        if (this.phase !== 'folded' || this.fingers.size || this.opener || this.openQueue.length) return;
        this.flutter();
        this.invalidate();
      },
      this.touched ? 4500 : 2200,
    );
  }

  private flutter(): void {
    const line: 0 | 1 = this.sim.creaseOpenness(1) < OPEN_ENOUGH ? 1 : 0;
    const corner = flapCorner(this.sim, line);
    this.sim.impulse(corner, 0, 1.25, 0);
  }

  private draw(): void {
    if (this.lost) return;
    this.camera.update();
    computeNormals(this.sim.pos, this.sim.indices, this.renderNormals);
    const folded: [number, number] = [
      this.sim.creaseOpenness(0) < 0.5 ? 1 : 0,
      this.sim.creaseOpenness(1) < 0.5 ? 1 : 0,
    ];
    this.renderer.draw(this.camera, this.sim.pos, this.renderNormals, this.crease, folded);
  }

  /** Drop the resolution a notch if the device keeps missing frames. */
  private adaptQuality(rawDt: number, busy: boolean): void {
    if (!busy || rawDt > 0.25) return;
    this.activeTime += rawDt;
    if (rawDt > 1 / 40) this.slowTime += rawDt;
    if (this.activeTime > 1.5) {
      if (this.slowTime / this.activeTime > 0.5 && this.scale > 1) {
        this.scale = Math.max(1, this.scale * 0.8);
        this.renderer.resize(this.camera.width, this.camera.height, this.scale);
      }
      this.activeTime = 0;
      this.slowTime = 0;
    }
  }

  /** Stop drawing (e.g. while the page shows something else). */
  pause(): void {
    this.paused = true;
    clearTimeout(this.hintTimeout);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resume(): void {
    this.paused = false;
    this.invalidate();
  }

  /** Where a corner of the paper is on screen, for placing hints. */
  screenOf(particle: number): [number, number] {
    const p = this.sim.pos;
    this.camera.update();
    return this.camera.project(p[particle * 3], p[particle * 3 + 1], p[particle * 3 + 2]);
  }

  dispose(): void {
    clearTimeout(this.hintTimeout);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const off of this.cleanup) off();
    this.renderer.dispose();
  }
}
