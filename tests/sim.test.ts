import { describe, expect, it } from 'vitest';
import { FlapOpener, foldPose } from '../src/sim/fold';
import { PaperSim } from '../src/sim/paper';

const FRAME = 1 / 60;

function run(sim: PaperSim, seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) sim.step(FRAME);
}

function finite(sim: PaperSim): boolean {
  return sim.pos.every(Number.isFinite);
}

function maxStretch(sim: PaperSim): number {
  let worst = 0;
  const p = sim.pos;
  for (let iz = 0; iz <= sim.nz; iz++) {
    for (let ix = 0; ix < sim.nx; ix++) {
      const a = sim.idx(ix, iz) * 3;
      const b = sim.idx(ix + 1, iz) * 3;
      const len = Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
      worst = Math.max(worst, Math.abs(len - sim.h) / sim.h);
    }
  }
  return worst;
}

function folded(sim: PaperSim): void {
  const pose = new Float32Array(sim.n * 3);
  foldPose(sim, Math.PI, Math.PI, pose);
  sim.adoptPose(pose, true);
}

function open(sim: PaperSim, line: 0 | 1): void {
  const opener = new FlapOpener(sim, line);
  while (!opener.update(FRAME)) sim.step(FRAME);
}

describe.each([
  [16, 20],
  [24, 30],
])('paper %ix%i', (nx, nz) => {
  it('rests flat and falls asleep', () => {
    const sim = new PaperSim(nx, nz);
    run(sim, 1);
    expect(finite(sim)).toBe(true);
    expect(sim.awake).toBe(false);
  });

  it('survives a zero-length frame', () => {
    const sim = new PaperSim(nx, nz);
    sim.step(0);
    sim.step(FRAME);
    expect(finite(sim)).toBe(true);
  });

  it('stays folded when left alone', () => {
    const sim = new PaperSim(nx, nz);
    folded(sim);
    run(sim, 2);
    expect(finite(sim)).toBe(true);
    expect(sim.creaseOpenness(0)).toBeLessThan(0.2);
    expect(sim.creaseOpenness(1)).toBeLessThan(0.2);
    expect(sim.awake).toBe(false);
  });

  it('unfolds both flaps without dragging the note around', () => {
    const sim = new PaperSim(nx, nz);
    folded(sim);
    run(sim, 1);
    open(sim, 1);
    run(sim, 1.5);
    expect(sim.creaseOpenness(1)).toBeGreaterThan(0.75);
    open(sim, 0);
    run(sim, 2);
    expect(finite(sim)).toBe(true);
    expect(sim.creaseOpenness(0)).toBeGreaterThan(0.75);
    expect(sim.creaseOpenness(1)).toBeGreaterThan(0.75);
    expect(maxStretch(sim)).toBeLessThan(0.05);
    // Back near where a flat sheet would lie.
    let worst = 0;
    for (let i = 0; i < sim.n; i++) {
      worst = Math.max(worst, Math.hypot(sim.pos[i * 3] - sim.restX[i], sim.pos[i * 3 + 2] - sim.restZ[i]));
    }
    expect(worst).toBeLessThan(0.15);
  });

  it('follows a dragged corner and settles after letting go', () => {
    const sim = new PaperSim(nx, nz);
    const g = sim.grab(sim.idx(nx, nz));
    for (let t = 0; t < 1; t += FRAME) {
      const k = Math.min(1, t / 0.4);
      sim.moveGrab(g, 0.5 - 0.3 * k, 0.4 * k, 0.625 - 0.3 * k);
      sim.step(FRAME);
    }
    expect(sim.pos[g.particle * 3 + 1]).toBeCloseTo(0.4, 2);
    expect(maxStretch(sim)).toBeLessThan(0.12);
    sim.release(g, 2, [0.5, 0, 0]);
    run(sim, 3);
    expect(finite(sim)).toBe(true);
    expect(Math.max(...Array.from(sim.pos).filter((_, k) => k % 3 === 1))).toBeLessThan(0.02);
  });
});

it('refuses grids without a middle line to fold on', () => {
  expect(() => new PaperSim(20, 25)).toThrow();
});
