/**
 * A camera looking straight down at the table (the y = 0 plane). Because it's
 * exactly top-down, the table maps to the screen as a plain scaled rectangle,
 * which makes it easy to line the 3D paper up with DOM elements.
 */

export interface CameraState {
  /** World point under the centre of the screen. */
  cx: number;
  cz: number;
  /** Height of the camera above the table. */
  dist: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WorldRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export class Camera {
  readonly fovY = (26 * Math.PI) / 180;
  readonly tanHalf = Math.tan(this.fovY / 2);
  /** Viewport size in CSS pixels. */
  width = 1;
  height = 1;
  state: CameraState = { cx: 0, cz: 0, dist: 3 };
  readonly viewProj = new Float32Array(16);

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  get aspect(): number {
    return this.width / this.height;
  }

  update(): void {
    const { cx, cz, dist } = this.state;
    const f = 1 / this.tanHalf;
    const a = this.aspect;
    const near = Math.max(0.05, dist - 2.5);
    const far = dist + 0.5;
    const A = (far + near) / (near - far);
    const B = (2 * far * near) / (near - far);
    const m = this.viewProj;
    // clip = P * view, with view: x_c = x - cx, y_c = cz - z, z_c = y - dist.
    m[0] = f / a;
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = 0;
    m[5] = 0;
    m[6] = A;
    m[7] = -1;
    m[8] = 0;
    m[9] = -f;
    m[10] = 0;
    m[11] = 0;
    m[12] = (-f / a) * cx;
    m[13] = f * cz;
    m[14] = -A * dist + B;
    m[15] = dist;
  }

  /** Camera that shows `world` (on the table) exactly inside `screen` (CSS px). */
  fit(world: WorldRect, screen: ScreenRect): CameraState {
    const ww = Math.max(1e-3, world.x1 - world.x0);
    const wd = Math.max(1e-3, world.z1 - world.z0);
    const scale = Math.min(screen.width / ww, screen.height / wd);
    const dist = this.height / 2 / scale / this.tanHalf;
    const rcx = screen.left + screen.width / 2;
    const rcy = screen.top + screen.height / 2;
    return {
      cx: (world.x0 + world.x1) / 2 + (this.width / 2 - rcx) / scale,
      cz: (world.z0 + world.z1) / 2 + (this.height / 2 - rcy) / scale,
      dist,
    };
  }

  /** The part of the table that's visible for a camera state. */
  visibleTable(s: CameraState = this.state): WorldRect {
    const halfH = s.dist * this.tanHalf;
    const halfW = halfH * this.aspect;
    return { x0: s.cx - halfW, x1: s.cx + halfW, z0: s.cz - halfH, z1: s.cz + halfH };
  }

  /** Ray through a screen point (CSS px): origin and (unnormalised) direction. */
  ray(px: number, py: number): [number, number, number, number, number, number] {
    const { cx, cz, dist } = this.state;
    const nx = (2 * px) / this.width - 1;
    const ny = 1 - (2 * py) / this.height;
    return [cx, dist, cz, nx * this.tanHalf * this.aspect, -1, -ny * this.tanHalf];
  }

  /** Where a screen point lands on the horizontal plane at height `y`. */
  onPlane(px: number, py: number, y: number): [number, number] {
    const [ox, oy, oz, dx, , dz] = this.ray(px, py);
    const s = oy - y;
    return [ox + dx * s, oz + dz * s];
  }

  /** World point to screen (CSS px). */
  project(x: number, y: number, z: number): [number, number] {
    const m = this.viewProj;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [((cx / cw + 1) / 2) * this.width, ((1 - cy / cw) / 2) * this.height];
  }
}

export function lerpCamera(a: CameraState, b: CameraState, t: number): CameraState {
  // Interpolate zoom in log space so it feels even.
  const dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * t);
  return { cx: a.cx + (b.cx - a.cx) * t, cz: a.cz + (b.cz - a.cz) * t, dist };
}
