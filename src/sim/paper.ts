/**
 * A sheet of paper as a grid of particles, solved with small-step XPBD.
 *
 * - Distance constraints (structural + shear) keep the sheet from stretching.
 * - "Triplet" bending constraints (Kelager-style curvature) make it stiff like
 *   paper rather than floppy like cloth. Where the note was folded, the sheet
 *   becomes a weak hinge: it bends easily there, and a folded note stays
 *   folded under its own weight.
 * - Paper is a "dead" material: internal damping kills wobbles, and once
 *   nobody is touching it the air thickens until it settles and sleeps.
 * - Layer contacts let folded layers rest on each other. Where two bits of
 *   sheet overlap and both lie roughly flat, the pair remembers which one is on
 *   top and keeps it that way, so layers can be paper-thin without passing
 *   through each other. Steep or crumpled bits don't take part: there "on top"
 *   means nothing, and guessing would make the sheet fight itself.
 * - While a finger holds the sheet, tethers stop any point from getting
 *   further from the finger than it is across the flat paper, so the whole
 *   sheet follows at once instead of stretching like rubber.
 * - Air drag acts mostly along the surface normal, so the sheet floats.
 *
 * World axes: x right, y up (out of the table), z towards the bottom of the
 * screen. The table is the plane y = 0. Units: the paper is 1 unit wide.
 */

export interface Grab {
  particle: number;
  /** Kinematic position at the start of the current frame. */
  fx: number;
  fy: number;
  fz: number;
  /** Target for the end of the current frame. */
  tx: number;
  ty: number;
  tz: number;
  savedInvMass: number;
  /** Flat-paper distance from the held point to every particle, or null for no tethers. */
  reach: Float32Array | null;
}

export interface SimTuning {
  gravity: number;
  /** XPBD compliance for bending, per unit (scaled by dt² internally). */
  bendCompliance: number;
  creaseCompliance: number;
  shearCompliance: number;
  /** Per-second damping of velocity along the normal (air resistance). */
  airNormal: number;
  /** Per-second damping of all velocity. */
  airAll: number;
  /** Fraction of tangential motion removed per substep on the table. */
  groundFriction: number;
  /** Fraction of relative motion removed per substep between touching layers. */
  layerFriction: number;
  maxSpeed: number;
  /** Fraction of neighbours' relative velocity removed per substep (paper is "dead"). */
  internalDamping: number;
  /** Seconds after the last touch before the air gets gradually thicker. */
  settleAfter: number;
  /** Passes over the no-stretch constraints per substep. */
  stretchPasses: number;
}

export const DEFAULT_TUNING: SimTuning = {
  gravity: 14,
  bendCompliance: 2.0e-6,
  creaseCompliance: 3.0e-4,
  shearCompliance: 0,
  airNormal: 5.5,
  airAll: 0.6,
  groundFriction: 0.08,
  layerFriction: 0.12,
  maxSpeed: 7,
  internalDamping: 0.02,
  settleAfter: 1,
  stretchPasses: 2,
};

const SUB_DT = 1 / 480;
const MAX_SUBSTEPS = 24;

export class PaperSim {
  readonly nx: number;
  readonly nz: number;
  readonly n: number;
  readonly width: number;
  readonly height: number;
  readonly h: number;
  /** Gap kept between stacked layers. */
  readonly thickness: number;

  readonly pos: Float32Array;
  readonly prev: Float32Array;
  readonly vel: Float32Array;
  readonly invMass: Float32Array;
  readonly normal: Float32Array;
  readonly restX: Float32Array;
  readonly restZ: Float32Array;
  readonly indices: Uint16Array | Uint32Array;

  tuning: SimTuning;
  bounds = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
  grabs: Grab[] = [];
  /** The sim stops stepping once everything has been still for a moment. */
  awake = true;

  private calm = 0;
  /** Seconds since anything held or poked the sheet. */
  private untouched = 0;

  private readonly dA: Int32Array;
  private readonly dB: Int32Array;
  private readonly dRest: Float32Array;
  private readonly dShear: Uint8Array;

  private readonly bA: Int32Array;
  private readonly bM: Int32Array;
  private readonly bB: Int32Array;
  /** 1 where the sheet has been creased: a weak hinge instead of stiff paper. */
  readonly bPlastic: Uint8Array;
  /** -1, or which fold line (0 = horizontal "A", 1 = vertical "B") the triplet's middle sits on. */
  readonly bCrease: Int8Array;

  // Layer contacts: candidate pairs that are near each other, found with a
  // uniform grid and only rebuilt once some particle has moved a little.
  private cellStart = new Int32Array(1024);
  private readonly cellEntries: Int32Array;
  private readonly cellOf: Int32Array;
  private readonly builtAt: Float32Array;
  private pairI = new Int32Array(2048);
  private pairJ = new Int32Array(2048);
  /** 0 = undecided, 1 = j stays above i, 2 = i stays above j. */
  private pairUp = new Uint8Array(2048);
  private backI = new Int32Array(2048);
  private backJ = new Int32Array(2048);
  private backUp = new Uint8Array(2048);
  /** Substeps a pair has spent on the "wrong" side despite being pushed. */
  private pairStrain = new Uint16Array(2048);
  private pairCount = 0;
  /** Remembered order per (i * n + j), so a pair keeps its order across rebuilds. */
  private readonly pairOrder: Uint8Array;
  private contactsDirty = true;
  /** Particles above this height (since the last rebuild) can't touch the rest yet. */
  private bandY = 0;

  constructor(nx: number, nz: number, width = 1, tuning: SimTuning = DEFAULT_TUNING) {
    if (nx % 2 || nz % 2) throw new Error('Fold lines need an even grid');
    this.nx = nx;
    this.nz = nz;
    this.n = (nx + 1) * (nz + 1);
    this.width = width;
    this.h = width / nx;
    this.height = this.h * nz;
    this.thickness = this.h * 0.12;
    this.tuning = { ...tuning };

    const n = this.n;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.invMass = new Float32Array(n).fill(1);
    this.normal = new Float32Array(n * 3);
    this.restX = new Float32Array(n);
    this.restZ = new Float32Array(n);

    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) {
        const i = this.idx(ix, iz);
        this.restX[i] = -width / 2 + ix * this.h;
        this.restZ[i] = -this.height / 2 + iz * this.h;
      }
    }

    // Triangles: wound so the front (written) side faces +y, diagonals alternate.
    const tris: number[] = [];
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = this.idx(ix, iz);
        const b = this.idx(ix + 1, iz);
        const c = this.idx(ix, iz + 1);
        const d = this.idx(ix + 1, iz + 1);
        if ((ix + iz) % 2 === 0) tris.push(a, c, b, b, c, d);
        else tris.push(a, c, d, a, d, b);
      }
    }
    this.indices = n > 65535 ? new Uint32Array(tris) : new Uint16Array(tris);

    // Distance constraints.
    const da: number[] = [];
    const db: number[] = [];
    const shear: number[] = [];
    const addD = (a: number, b: number, s: number) => {
      da.push(a);
      db.push(b);
      shear.push(s);
    };
    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) {
        const i = this.idx(ix, iz);
        if (ix < nx) addD(i, this.idx(ix + 1, iz), 0);
        if (iz < nz) addD(i, this.idx(ix, iz + 1), 0);
        // Triangle diagonals only: with every triangle edge constrained the
        // sheet is already rigid in-plane.
        if (ix < nx && iz < nz) {
          if ((ix + iz) % 2 === 0) addD(this.idx(ix + 1, iz), this.idx(ix, iz + 1), 1);
          else addD(i, this.idx(ix + 1, iz + 1), 1);
        }
      }
    }
    this.dA = new Int32Array(da);
    this.dB = new Int32Array(db);
    this.dShear = new Uint8Array(shear);
    this.dRest = new Float32Array(da.length);
    for (let k = 0; k < da.length; k++) {
      const a = da[k];
      const b = db[k];
      this.dRest[k] = Math.hypot(this.restX[a] - this.restX[b], this.restZ[a] - this.restZ[b]);
    }

    // Bending triplets along rows and columns.
    const ba: number[] = [];
    const bm: number[] = [];
    const bb: number[] = [];
    const bc: number[] = [];
    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 1; ix < nx; ix++) {
        ba.push(this.idx(ix - 1, iz));
        bm.push(this.idx(ix, iz));
        bb.push(this.idx(ix + 1, iz));
        bc.push(ix * 2 === nx ? 1 : -1);
      }
    }
    for (let ix = 0; ix <= nx; ix++) {
      for (let iz = 1; iz < nz; iz++) {
        ba.push(this.idx(ix, iz - 1));
        bm.push(this.idx(ix, iz));
        bb.push(this.idx(ix, iz + 1));
        bc.push(iz * 2 === nz ? 0 : -1);
      }
    }
    this.bA = new Int32Array(ba);
    this.bM = new Int32Array(bm);
    this.bB = new Int32Array(bb);
    this.bCrease = new Int8Array(bc);
    this.bPlastic = new Uint8Array(ba.length);

    this.cellEntries = new Int32Array(n);
    this.cellOf = new Int32Array(n);
    this.builtAt = new Float32Array(n * 3);
    this.pairOrder = new Uint8Array(n * n);

    this.reset();
  }

  idx(ix: number, iz: number): number {
    return ix + iz * (this.nx + 1);
  }

  /** Lay the sheet flat on the table, uncreased. */
  reset(): void {
    for (let i = 0; i < this.n; i++) {
      this.pos[i * 3] = this.restX[i];
      this.pos[i * 3 + 1] = 0;
      this.pos[i * 3 + 2] = this.restZ[i];
    }
    this.prev.set(this.pos);
    this.vel.fill(0);
    this.bPlastic.fill(0);
    this.grabs = [];
    this.invMass.fill(1);
    this.forgetContacts();
    this.wake();
  }

  private forgetContacts(): void {
    this.pairOrder.fill(0);
    this.pairCount = 0;
    this.contactsDirty = true;
  }

  /**
   * Take over a pose (e.g. from the folding animation). Any triplet that is
   * noticeably bent in this pose becomes a crease (a weak hinge).
   */
  adoptPose(positions: Float32Array, markCreases: boolean): void {
    this.pos.set(positions);
    this.prev.set(positions);
    this.vel.fill(0);
    this.forgetContacts();
    if (markCreases) {
      const threshold = this.h * 0.35;
      for (let k = 0; k < this.bA.length; k++) {
        if (this.tripletCurvature(k) > threshold) this.bPlastic[k] = 1;
      }
    }
    this.wake();
  }

  /** How open a fold line is: 0 = folded flat, 1 = flat open. */
  creaseOpenness(line: 0 | 1): number {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < this.bA.length; k++) {
      if (this.bCrease[k] !== line) continue;
      sum += this.tripletCurvature(k);
      count++;
    }
    if (count === 0) return 1;
    return Math.max(0, Math.min(1, 1 - sum / count / (1.9 * this.h)));
  }

  private tripletCurvature(k: number): number {
    const p = this.pos;
    const a = this.bA[k] * 3;
    const m = this.bM[k] * 3;
    const b = this.bB[k] * 3;
    const sx = p[a] + p[b] - 2 * p[m];
    const sy = p[a + 1] + p[b + 1] - 2 * p[m + 1];
    const sz = p[a + 2] + p[b + 2] - 2 * p[m + 2];
    return Math.sqrt(sx * sx + sy * sy + sz * sz);
  }

  wake(): void {
    this.awake = true;
    this.calm = 0;
  }

  /** Hold a particle. With `tether`, the rest of the sheet can't stretch away from it. */
  grab(particle: number, tether = false): Grab {
    const p = this.pos;
    let reach: Float32Array | null = null;
    if (tether) {
      reach = new Float32Array(this.n);
      const rx = this.restX[particle];
      const rz = this.restZ[particle];
      for (let i = 0; i < this.n; i++) reach[i] = Math.hypot(this.restX[i] - rx, this.restZ[i] - rz);
    }
    const g: Grab = {
      reach,
      particle,
      fx: p[particle * 3],
      fy: p[particle * 3 + 1],
      fz: p[particle * 3 + 2],
      tx: p[particle * 3],
      ty: p[particle * 3 + 1],
      tz: p[particle * 3 + 2],
      savedInvMass: this.invMass[particle],
    };
    this.invMass[particle] = 0;
    this.grabs.push(g);
    this.untouched = 0;
    this.wake();
    return g;
  }

  moveGrab(g: Grab, x: number, y: number, z: number): void {
    g.tx = x;
    g.ty = Math.max(0, y);
    g.tz = z;
    this.wake();
  }

  /**
   * Let go of a particle. `velocity` (e.g. the finger's, smoothed) replaces
   * whatever the last substep left it with, which can spike on jittery input.
   */
  release(g: Grab, maxSpeed = 4, velocity?: [number, number, number]): void {
    const i = this.grabs.indexOf(g);
    if (i < 0) return;
    this.grabs.splice(i, 1);
    this.invMass[g.particle] = g.savedInvMass || 1;
    const v = this.vel;
    const o = g.particle * 3;
    if (velocity) {
      v[o] = velocity[0];
      v[o + 1] = velocity[1];
      v[o + 2] = velocity[2];
    }
    const s = Math.hypot(v[o], v[o + 1], v[o + 2]);
    if (s > maxSpeed) {
      const f = maxSpeed / s;
      v[o] *= f;
      v[o + 1] *= f;
      v[o + 2] *= f;
    }
    this.wake();
  }

  releaseAll(): void {
    for (const g of [...this.grabs]) this.release(g);
  }

  /** Slide the whole sheet without changing its shape or speed. */
  translate(dx: number, dz: number): void {
    const { pos, prev } = this;
    for (let o = 0; o < pos.length; o += 3) {
      pos[o] += dx;
      pos[o + 2] += dz;
      prev[o] += dx;
      prev[o + 2] += dz;
    }
    this.contactsDirty = true;
    this.wake();
  }

  impulse(particle: number, vx: number, vy: number, vz: number): void {
    const o = particle * 3;
    this.vel[o] += vx;
    this.vel[o + 1] += vy;
    this.vel[o + 2] += vz;
    this.untouched = 0;
    this.wake();
  }

  /** Advance by one display frame. Returns false if the sim is asleep. */
  step(frameDt: number): boolean {
    if (!this.awake) return false;
    if (!(frameDt > 0)) return true;
    const subs = Math.max(1, Math.min(MAX_SUBSTEPS, Math.round(frameDt / SUB_DT)));
    const dt = frameDt / subs;
    computeNormals(this.pos, this.indices, this.normal);
    for (const g of this.grabs) {
      const o = g.particle * 3;
      g.fx = this.pos[o];
      g.fy = this.pos[o + 1];
      g.fz = this.pos[o + 2];
    }
    this.untouched = this.grabs.length ? 0 : this.untouched + frameDt;
    for (let s = 0; s < subs; s++) this.substep(dt, (s + 1) / subs);

    // Sleep once nothing has moved for a while.
    let maxV2 = 0;
    const v = this.vel;
    for (let i = 0; i < v.length; i += 3) {
      const s2 = v[i] * v[i] + v[i + 1] * v[i + 1] + v[i + 2] * v[i + 2];
      if (s2 > maxV2) maxV2 = s2;
    }
    if (this.grabs.length === 0 && (maxV2 < 0.0004 || this.untouched > 4)) {
      // Asleep once still, and in any case a few seconds after the last touch.
      this.calm += frameDt;
      if (this.calm > 0.4 || this.untouched > 4) {
        this.awake = false;
        v.fill(0);
      }
    } else {
      this.calm = 0;
    }
    return true;
  }

  private substep(dt: number, frac: number): void {
    const { pos, prev, vel, invMass, normal, n } = this;
    const T = this.tuning;
    const gdt = T.gravity * dt;
    const normalDamp = 1 - Math.exp(-T.airNormal * dt);
    // Once nobody's touching it, the air slowly thickens so the sheet always
    // comes to rest instead of trembling on.
    const settle = 1 + Math.min(30, Math.max(0, this.untouched - T.settleAfter) * 10);
    const allDamp = Math.exp(-T.airAll * settle * dt);
    const maxSp2 = T.maxSpeed * T.maxSpeed;

    for (let i = 0; i < n; i++) {
      const o = i * 3;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      if (invMass[i] === 0) continue;
      let vx = vel[o];
      let vy = vel[o + 1] - gdt;
      let vz = vel[o + 2];
      const nx = normal[o];
      const ny = normal[o + 1];
      const nz = normal[o + 2];
      const vn = (vx * nx + vy * ny + vz * nz) * normalDamp;
      vx = (vx - vn * nx) * allDamp;
      vy = (vy - vn * ny) * allDamp;
      vz = (vz - vn * nz) * allDamp;
      const s2 = vx * vx + vy * vy + vz * vz;
      if (s2 > maxSp2) {
        const f = T.maxSpeed / Math.sqrt(s2);
        vx *= f;
        vy *= f;
        vz *= f;
      }
      pos[o] += vx * dt;
      pos[o + 1] += vy * dt;
      pos[o + 2] += vz * dt;
    }

    for (const g of this.grabs) {
      const o = g.particle * 3;
      pos[o] = g.fx + (g.tx - g.fx) * frac;
      pos[o + 1] = g.fy + (g.ty - g.fy) * frac;
      pos[o + 2] = g.fz + (g.tz - g.fz) * frac;
    }

    this.solveTethers();
    for (let k = 0; k < this.tuning.stretchPasses; k++) this.solveDistances(dt);
    this.solveBending(dt);
    this.solveContacts();
    this.solveBounds();

    const inv = 1 / dt;
    for (let k = 0; k < pos.length; k++) vel[k] = (pos[k] - prev[k]) * inv;
    this.dampInternal();
  }

  /** Paper is a "dead" material: neighbours stop moving relative to each other quickly. */
  private dampInternal(): void {
    const { vel, invMass, dA, dB } = this;
    const k = this.tuning.internalDamping;
    if (k <= 0) return;
    for (let e = 0; e < dA.length; e++) {
      const a = dA[e];
      const b = dB[e];
      const wa = invMass[a];
      const wb = invMass[b];
      const w = wa + wb;
      if (w === 0) continue;
      const oa = a * 3;
      const ob = b * 3;
      const fa = (k * wa) / w;
      const fb = (k * wb) / w;
      for (let c = 0; c < 3; c++) {
        const dv = vel[ob + c] - vel[oa + c];
        vel[oa + c] += dv * fa;
        vel[ob + c] -= dv * fb;
      }
    }
  }

  private solveTethers(): void {
    const { pos, invMass, n } = this;
    for (const g of this.grabs) {
      const reach = g.reach;
      if (!reach) continue;
      const og = g.particle * 3;
      const gx = pos[og];
      const gy = pos[og + 1];
      const gz = pos[og + 2];
      for (let i = 0; i < n; i++) {
        if (invMass[i] === 0) continue;
        const o = i * 3;
        const dx = pos[o] - gx;
        const dy = pos[o + 1] - gy;
        const dz = pos[o + 2] - gz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const r = reach[i];
        if (d2 <= r * r) continue;
        const f = r / Math.sqrt(d2);
        pos[o] = gx + dx * f;
        pos[o + 1] = gy + dy * f;
        pos[o + 2] = gz + dz * f;
      }
    }
  }

  private solveDistances(dt: number): void {
    const { pos, invMass, dA, dB, dRest, dShear } = this;
    const shearAlpha = this.tuning.shearCompliance / (dt * dt);
    for (let k = 0; k < dA.length; k++) {
      const a = dA[k];
      const b = dB[k];
      const wa = invMass[a];
      const wb = invMass[b];
      const w = wa + wb;
      if (w === 0) continue;
      const oa = a * 3;
      const ob = b * 3;
      const dx = pos[oa] - pos[ob];
      const dy = pos[oa + 1] - pos[ob + 1];
      const dz = pos[oa + 2] - pos[ob + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const alpha = dShear[k] ? shearAlpha : 0;
      const s = -(len - dRest[k]) / (len * (w + alpha));
      pos[oa] += dx * s * wa;
      pos[oa + 1] += dy * s * wa;
      pos[oa + 2] += dz * s * wa;
      pos[ob] -= dx * s * wb;
      pos[ob + 1] -= dy * s * wb;
      pos[ob + 2] -= dz * s * wb;
    }
  }

  private solveBending(dt: number): void {
    const { pos, invMass, bA, bM, bB, bPlastic } = this;
    const idt2 = 1 / (dt * dt);
    const bendAlpha = this.tuning.bendCompliance * idt2;
    const creaseAlpha = this.tuning.creaseCompliance * idt2;
    for (let k = 0; k < bA.length; k++) {
      const a = bA[k];
      const m = bM[k];
      const b = bB[k];
      const wa = invMass[a];
      const wm = invMass[m];
      const wb = invMass[b];
      const W = wa + wb + 4 * wm;
      if (W === 0) continue;
      const oa = a * 3;
      const om = m * 3;
      const ob = b * 3;
      const sx = pos[oa] + pos[ob] - 2 * pos[om];
      const sy = pos[oa + 1] + pos[ob + 1] - 2 * pos[om + 1];
      const sz = pos[oa + 2] + pos[ob + 2] - 2 * pos[om + 2];
      const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (len < 1e-9) continue;
      // Creases are weak hinges: they bend easily and only gently prefer flat,
      // so a folded note stays folded under its own weight and can never get
      // into a fight it can't win (which is what makes simulations tremble).
      const C = len;
      const dl = -C / (W + (bPlastic[k] === 1 ? creaseAlpha : bendAlpha));
      const f = dl / len;
      pos[oa] += sx * f * wa;
      pos[oa + 1] += sy * f * wa;
      pos[oa + 2] += sz * f * wa;
      pos[ob] += sx * f * wb;
      pos[ob + 1] += sy * f * wb;
      pos[ob + 2] += sz * f * wb;
      pos[om] -= 2 * sx * f * wm;
      pos[om + 1] -= 2 * sy * f * wm;
      pos[om + 2] -= 2 * sz * f * wm;
    }
  }

  /** Find pairs close enough to touch soon that aren't neighbours on the sheet. */
  private buildContacts(): void {
    const { pos, n, cellEntries, cellOf, restX, restZ, pairOrder } = this;
    const h = this.h;
    const R = h * 1.5;
    const R2 = R * R;
    const inv = 1 / R;
    const minRest2 = (h * 1.9) ** 2;

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3];
      const z = pos[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const gw = Math.floor((maxX - minX) * inv) + 1;
    const gh = Math.floor((maxZ - minZ) * inv) + 1;
    const cells = gw * gh;
    if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells * 2 + 1);
    const cs = this.cellStart;
    cs.fill(0, 0, cells + 1);
    for (let i = 0; i < n; i++) {
      const c =
        Math.floor((pos[i * 3] - minX) * inv) + Math.floor((pos[i * 3 + 2] - minZ) * inv) * gw;
      cellOf[i] = c;
      cs[c]++;
    }
    let acc = 0;
    for (let c = 0; c < cells; c++) {
      acc += cs[c];
      cs[c] = acc;
    }
    cs[cells] = acc;
    for (let i = 0; i < n; i++) cellEntries[--cs[cellOf[i]]] = i;

    let outI = this.backI;
    let outJ = this.backJ;
    let outUp = this.backUp;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const oi = i * 3;
      const x = pos[oi];
      const y = pos[oi + 1];
      const z = pos[oi + 2];
      const cx = Math.floor((x - minX) * inv);
      const cz = Math.floor((z - minZ) * inv);
      for (let zz = Math.max(0, cz - 1); zz <= Math.min(gh - 1, cz + 1); zz++) {
        for (let xx = Math.max(0, cx - 1); xx <= Math.min(gw - 1, cx + 1); xx++) {
          const c = xx + zz * gw;
          const end = cs[c + 1];
          for (let e = cs[c]; e < end; e++) {
            const j = cellEntries[e];
            if (j <= i) continue;
            const oj = j * 3;
            const dx = pos[oj] - x;
            const dy = pos[oj + 1] - y;
            const dz = pos[oj + 2] - z;
            if (dx * dx + dy * dy + dz * dz > R2) continue;
            const rx = restX[j] - restX[i];
            const rz = restZ[j] - restZ[i];
            if (rx * rx + rz * rz < minRest2) continue;
            const key = i * n + j;
            // 0 = not decided yet: that happens on first contact, see solveContacts.
            const up = pairOrder[key] & 3;
            pairOrder[key] = up | 4;
            if (count === outI.length) {
              const gi = new Int32Array(count * 2);
              const gj = new Int32Array(count * 2);
              const gu = new Uint8Array(count * 2);
              gi.set(outI);
              gj.set(outJ);
              gu.set(outUp);
              outI = gi;
              outJ = gj;
              outUp = gu;
            }
            outI[count] = i;
            outJ[count] = j;
            outUp[count] = up;
            count++;
          }
        }
      }
    }
    // Pairs that drifted apart forget their order; survivors drop the "seen" bit.
    const oldI = this.pairI;
    const oldJ = this.pairJ;
    for (let k = 0; k < this.pairCount; k++) {
      const key = oldI[k] * n + oldJ[k];
      if ((pairOrder[key] & 4) === 0) pairOrder[key] = 0;
    }
    for (let k = 0; k < count; k++) pairOrder[outI[k] * n + outJ[k]] &= 3;

    this.backI = oldI;
    this.backJ = oldJ;
    this.backUp = this.pairUp;
    this.pairI = outI;
    this.pairJ = outJ;
    this.pairUp = outUp;
    this.pairCount = count;
    if (this.pairStrain.length < outI.length) this.pairStrain = new Uint16Array(outI.length);
    this.pairStrain.fill(0, 0, count);
    let top = 0;
    for (let k = 0; k < count; k++) {
      top = Math.max(top, pos[outI[k] * 3 + 1], pos[outJ[k] * 3 + 1]);
    }
    this.bandY = top + R;
    this.builtAt.set(pos);
    this.contactsDirty = false;
  }

  private solveContacts(): void {
    const { pos, prev, invMass, n, builtAt } = this;
    if (!this.contactsDirty) {
      // Rebuild once particles near the stack have moved relative to each
      // other; moving the whole sheet, or a flap up in the air, doesn't count.
      const band = this.bandY;
      let mx = 0;
      let my = 0;
      let mz = 0;
      let c = 0;
      for (let o = 0; o < pos.length; o += 3) {
        if (pos[o + 1] > band && builtAt[o + 1] > band) continue;
        mx += pos[o] - builtAt[o];
        my += pos[o + 1] - builtAt[o + 1];
        mz += pos[o + 2] - builtAt[o + 2];
        c++;
      }
      if (c > 0) {
        mx /= c;
        my /= c;
        mz /= c;
        const limit2 = (this.h * 0.35) ** 2;
        for (let o = 0; o < pos.length; o += 3) {
          if (pos[o + 1] > band && builtAt[o + 1] > band) continue;
          const dx = pos[o] - builtAt[o] - mx;
          const dy = pos[o + 1] - builtAt[o + 1] - my;
          const dz = pos[o + 2] - builtAt[o + 2] - mz;
          if (dx * dx + dy * dy + dz * dz > limit2) {
            this.contactsDirty = true;
            break;
          }
        }
      }
    }
    if (this.contactsDirty) this.buildContacts();

    const { pairI, pairJ, pairUp, pairCount, pairOrder, normal, pairStrain } = this;
    const t = this.thickness;
    const reach2 = (this.h * 0.75) ** 2;
    const flipLimit = -this.h * 0.6;
    const fric = this.tuning.layerFriction;
    for (let k = 0; k < pairCount; k++) {
      const a = pairI[k];
      const b = pairJ[k];
      const oa = a * 3;
      const ob = b * 3;
      // Only where both bits of sheet lie roughly flat does "on top" mean
      // anything; elsewhere forget the order and stay out of the way.
      if (Math.abs(normal[oa + 1]) < 0.5 || Math.abs(normal[ob + 1]) < 0.5) {
        if (pairUp[k]) {
          pairUp[k] = 0;
          pairOrder[a * n + b] = 0;
        }
        continue;
      }
      const dx = pos[ob] - pos[oa];
      const dz = pos[ob + 2] - pos[oa + 2];
      if (dx * dx + dz * dz > reach2) continue;
      let order = pairUp[k];
      if (order === 0) {
        order = pos[ob + 1] >= pos[oa + 1] ? 1 : 2;
        pairUp[k] = order;
        pairOrder[a * n + b] = order;
      }
      const up = order === 1 ? b : a;
      const lo = order === 1 ? a : b;
      const ou = up * 3;
      const ol = lo * 3;
      const gap = pos[ou + 1] - pos[ol + 1];
      if (gap >= t) continue;
      // Stuck on the wrong side for a while means the rest of the sheet is
      // holding them there: accept it rather than fight forever.
      if (gap < -t) pairStrain[k]++;
      else pairStrain[k] = 0;
      if (gap < flipLimit || pairStrain[k] > 48) {
        pairStrain[k] = 0;
        // They went around an edge rather than through each other.
        pairUp[k] = order === 1 ? 2 : 1;
        pairOrder[a * n + b] = pairUp[k];
        continue;
      }
      const wu = invMass[up];
      const wl = invMass[lo];
      const w = wu + wl;
      if (w === 0) continue;
      const corr = (t - gap) / w;
      pos[ou + 1] += corr * wu;
      pos[ol + 1] -= corr * wl;
      // Friction: damp sliding between the layers.
      const rx = pos[ob] - prev[ob] - (pos[oa] - prev[oa]);
      const rz = pos[ob + 2] - prev[ob + 2] - (pos[oa + 2] - prev[oa + 2]);
      const fa = (fric * invMass[a]) / w;
      const fb = (fric * invMass[b]) / w;
      pos[oa] += rx * fa;
      pos[oa + 2] += rz * fa;
      pos[ob] -= rx * fb;
      pos[ob + 2] -= rz * fb;
    }
  }

  private solveBounds(): void {
    const { pos, prev, invMass, n } = this;
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const fr = this.tuning.groundFriction;
    for (let i = 0; i < n; i++) {
      if (invMass[i] === 0) continue;
      const o = i * 3;
      if (pos[o + 1] <= 0) {
        pos[o + 1] = 0;
        pos[o] -= (pos[o] - prev[o]) * fr;
        pos[o + 2] -= (pos[o + 2] - prev[o + 2]) * fr;
      }
      if (pos[o] < minX) pos[o] = minX;
      else if (pos[o] > maxX) pos[o] = maxX;
      if (pos[o + 2] < minZ) pos[o + 2] = minZ;
      else if (pos[o + 2] > maxZ) pos[o + 2] = maxZ;
    }
  }
}

/** Area-weighted vertex normals. */
export function computeNormals(
  pos: Float32Array,
  indices: Uint16Array | Uint32Array,
  out: Float32Array,
): void {
  out.fill(0);
  for (let k = 0; k < indices.length; k += 3) {
    const a = indices[k] * 3;
    const b = indices[k + 1] * 3;
    const c = indices[k + 2] * 3;
    const e1x = pos[b] - pos[a];
    const e1y = pos[b + 1] - pos[a + 1];
    const e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a];
    const e2y = pos[c + 1] - pos[a + 1];
    const e2z = pos[c + 2] - pos[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    out[a] += nx;
    out[a + 1] += ny;
    out[a + 2] += nz;
    out[b] += nx;
    out[b + 1] += ny;
    out[b + 2] += nz;
    out[c] += nx;
    out[c + 1] += ny;
    out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
}
