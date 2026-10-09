import type { PaperSim } from './paper';

/**
 * Analytic folding, used to animate the sender's note folding up and to build
 * the receiver's starting pose. The note is folded twice, like a note passed
 * in class:
 *
 *   fold A: the top half folds down over the bottom half (crease z = 0)
 *   fold B: the right half folds over the left half      (crease x = 0)
 *
 * Each layer wraps around a cylinder at the crease so stacked layers stay one
 * `thickness` apart, and the flap can curl a little while it is moving.
 */

const tmp: [number, number] = [0, 0];

/**
 * Position of a point `u` along a flap (distance from the crease in the flat
 * sheet), in the fold's cross-section plane: returns [outward, up].
 */
function wrap(
  u: number,
  y0: number,
  axisY: number,
  theta: number,
  curl: number,
  flapLength: number,
  out: [number, number],
): void {
  const r = Math.max(axisY - y0, 1e-6);
  const arc = r * theta;
  if (u <= arc) {
    const phi = u / r;
    out[0] = r * Math.sin(phi);
    out[1] = axisY - r * Math.cos(phi);
    return;
  }
  const bx = r * Math.sin(theta);
  const by = axisY - r * Math.cos(theta);
  const s = u - arc;
  const k = -curl / flapLength;
  if (Math.abs(k) < 1e-6) {
    out[0] = bx + s * Math.cos(theta);
    out[1] = by + s * Math.sin(theta);
  } else {
    out[0] = bx + (Math.sin(theta + k * s) - Math.sin(theta)) / k;
    out[1] = by + (Math.cos(theta) - Math.cos(theta + k * s)) / k;
  }
  if (out[1] < y0) out[1] = y0;
}

/** Curl of a moving flap: none at rest, a little lag while it swings. */
export function flapCurl(theta: number): number {
  return Math.min(theta, Math.PI - theta) * 0.42;
}

/**
 * Pose of the sheet with fold A at angle `thetaA` and fold B at `thetaB`
 * (0 = flat, PI = folded over). Fold B assumes fold A is complete.
 */
export function foldPose(sim: PaperSim, thetaA: number, thetaB: number, out: Float32Array): void {
  const t = sim.thickness;
  const curlA = flapCurl(thetaA);
  const curlB = flapCurl(thetaB);
  const halfH = sim.height / 2;
  const halfW = sim.width / 2;
  for (let i = 0; i < sim.n; i++) {
    const x0 = sim.restX[i];
    const z0 = sim.restZ[i];
    let x = x0;
    let y = 0;
    let z = z0;
    // Points on a fold line sit at the middle of their layer's arc, so outer
    // layers wrap visibly around inner ones (the grid is coarser than the arc).
    if (thetaA > 0 && z0 < 1e-6) {
      const onLine = z0 > -1e-6;
      wrap(onLine ? (t / 2) * (thetaA / 2) : -z0, 0, t / 2, thetaA, curlA, halfH, tmp);
      z = -tmp[0];
      y = tmp[1];
    }
    if (thetaB > 0 && x0 > -1e-6) {
      const onLine = x0 < 1e-6;
      const r = 1.5 * t - y;
      wrap(onLine ? r * (thetaB / 2) : x0, y, 1.5 * t, thetaB, curlB, halfW, tmp);
      x = tmp[0];
      y = tmp[1];
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
}

/** The free edge of the flap for fold A (top edge) or B (right edge). */
export function flapEdge(sim: PaperSim, line: 0 | 1): number[] {
  const out: number[] = [];
  if (line === 1) for (let iz = 0; iz <= sim.nz; iz++) out.push(sim.idx(sim.nx, iz));
  else for (let ix = 0; ix <= sim.nx; ix++) out.push(sim.idx(ix, 0));
  return out;
}

/** Particles along fold line A (middle row) or B (middle column). */
export function creaseLine(sim: PaperSim, line: 0 | 1): number[] {
  const out: number[] = [];
  if (line === 1) for (let iz = 0; iz <= sim.nz; iz++) out.push(sim.idx(sim.nx / 2, iz));
  else for (let ix = 0; ix <= sim.nx; ix++) out.push(sim.idx(ix, sim.nz / 2));
  return out;
}

/** A corner of the flap that's on top, handy for "this opens" hints. */
export function flapCorner(sim: PaperSim, line: 0 | 1): number {
  return line === 1 ? sim.idx(sim.nx, sim.nz) : sim.idx(0, 0);
}

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/**
 * A "virtual hand" that holds a flap's free edge and swings it open along the
 * analytic fold path, relative to wherever the note currently sits. Physics
 * does the rest (the paper bends, the crease yields, the flap settles).
 */
export class FlapOpener {
  private readonly sim: PaperSim;
  private readonly line: 0 | 1;
  private readonly duration: number;
  private readonly grabs: ReturnType<PaperSim['grab']>[];
  private readonly offsets: Float32Array;
  private readonly path: Float32Array;
  private time = 0;
  done = false;

  constructor(sim: PaperSim, line: 0 | 1, duration = 0.95) {
    this.sim = sim;
    this.line = line;
    this.duration = duration;
    const edge = flapEdge(sim, line);
    this.path = new Float32Array(sim.n * 3);
    this.pose(Math.PI);
    this.offsets = new Float32Array(edge.length * 3);
    // Keep the note where it is: swing about where the crease actually sits.
    // Along the crease axis each particle keeps its own offset, so the edge
    // isn't stretched or squashed.
    let ox = 0;
    let oz = 0;
    const hinge = creaseLine(sim, line);
    for (const p of hinge) {
      ox += sim.pos[p * 3] - this.path[p * 3];
      oz += sim.pos[p * 3 + 2] - this.path[p * 3 + 2];
    }
    ox /= hinge.length;
    oz /= hinge.length;
    edge.forEach((p, k) => {
      const own = line === 0 ? 0 : 2;
      this.offsets[k * 3] = own === 0 ? sim.pos[p * 3] - this.path[p * 3] : ox;
      this.offsets[k * 3 + 2] = own === 2 ? sim.pos[p * 3 + 2] - this.path[p * 3 + 2] : oz;
    });
    this.grabs = edge.map((p) => sim.grab(p));
  }

  private pose(theta: number): void {
    if (this.line === 1) foldPose(this.sim, Math.PI, theta, this.path);
    else foldPose(this.sim, theta, 0, this.path);
  }

  /** Advance the hand; returns true once the flap has been let go. */
  update(dt: number): boolean {
    if (this.done) return true;
    this.time += dt;
    const u = Math.min(1, this.time / this.duration);
    const e = easeInOut(u);
    this.pose(Math.PI * (1 - e));
    const lift = 0.1 * Math.sin(Math.PI * e);
    this.grabs.forEach((g, k) => {
      const o = g.particle * 3;
      this.sim.moveGrab(
        g,
        this.path[o] + this.offsets[k * 3],
        this.path[o + 1] + lift,
        this.path[o + 2] + this.offsets[k * 3 + 2],
      );
    });
    if (u >= 1) {
      for (const g of this.grabs) this.sim.release(g, 0.3);
      this.done = true;
    }
    return this.done;
  }

  cancel(): void {
    if (this.done) return;
    for (const g of this.grabs) this.sim.release(g, 0.3);
    this.done = true;
  }
}
