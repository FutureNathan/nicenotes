import type { Camera } from './camera';

/**
 * WebGL2 renderer for one sheet of paper on a table.
 *
 * Per frame:
 *  1. Shadow mask: the sheet is projected onto the table along the light into
 *     a small offscreen target. R = shadow strength, G = the highest bit of
 *     paper above that spot (MAX blending), which doubles as a height map for
 *     shadows the paper casts on itself (a lifted flap over the page below).
 *  2. Blur R (two cheap separable passes at low resolution) for a soft shadow.
 *  3. Draw the blurred shadow on the (transparent) table, then the paper.
 *
 * The canvas is transparent: the table itself is CSS behind it.
 */

const LIGHT = normalize([-0.34, 1, -0.42]);
const SHADOW_LIFT = 0.014;
const HEIGHT_SCALE = 1.2;
/** Depth priority between stacked layers while folded (world units per layer). */
const LAYER_BIAS = 0.014;

const PAPER_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUv;
layout(location=3) in vec2 aSide;
uniform mat4 uViewProj;
uniform vec2 uFolded;
uniform float uLayerBias;
out vec3 vNormal;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vNormal = aNormal;
  vUv = aUv;
  vWorld = aPos;
  vec4 p = uViewProj * vec4(aPos, 1.0);
  // Stacking order of this quarter of the sheet while folded (aSide = top
  // half, right half; uFolded = fold A / fold B closed). Within a few
  // thicknesses, lower layers lose depth ties: the grid is coarser than a
  // fold's radius, so inner layers' edges could otherwise poke through.
  float a = uFolded.x * aSide.x;
  float rank = mix(a, 3.0 - a, aSide.y * uFolded.y);
  vec4 q = uViewProj * vec4(aPos - vec3(0.0, (3.0 - rank) * uLayerBias, 0.0), 1.0);
  gl_Position = vec4(p.xy, q.z / q.w * p.w, p.w);
}`;

const PAPER_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
in vec3 vWorld;
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform sampler2D uMask;
uniform mat4 uViewProj;
uniform vec3 uLight;
uniform vec2 uShadowShift;
uniform float uLift;
uniform float uHeightScale;
uniform vec2 uCrease;
out vec4 outColor;

float creaseLine(float c, float strength) {
  float d = abs(c - 0.5);
  float w = fwidth(c) * 0.9 + 0.0005;
  return strength * (1.0 - smoothstep(w * 0.5, w * 1.6, d));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo;
  if (gl_FrontFacing) {
    albedo = texture(uFront, vUv).rgb;
  } else {
    n = -n;
    albedo = texture(uBack, vUv).rgb;
  }

  // Soft lines where the note was folded.
  float crease = max(creaseLine(vUv.y, uCrease.x), creaseLine(vUv.x, uCrease.y));
  albedo *= 1.0 - 0.07 * crease;

  // Light relative to a flat sheet, so flat paper shows exactly its colours.
  float flatLight = uLight.y;
  float shade = 1.0 + 0.5 * (dot(n, uLight) - flatLight);
  shade = max(shade, 0.68);

  // Shadow from paper above this point (looked up along the light).
  vec3 g = vec3(vWorld.x - uShadowShift.x * (vWorld.y + uLift), 0.0,
                vWorld.z - uShadowShift.y * (vWorld.y + uLift));
  vec4 c = uViewProj * vec4(g, 1.0);
  vec2 suv = c.xy / c.w * 0.5 + 0.5;
  float above = texture(uMask, suv).g * uHeightScale;
  float occluded = smoothstep(0.012, 0.09, above - vWorld.y);
  shade *= 1.0 - 0.3 * occluded;

  outColor = vec4(min(albedo * shade, vec3(1.0)), 1.0);
}`;

const MASK_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform vec2 uShadowShift;
uniform float uLift;
out float vHeight;
void main() {
  vHeight = aPos.y;
  vec3 g = vec3(aPos.x - uShadowShift.x * (aPos.y + uLift), 0.0,
                aPos.z - uShadowShift.y * (aPos.y + uLift));
  gl_Position = uViewProj * vec4(g, 1.0);
}`;

const MASK_FS = `#version 300 es
precision highp float;
in float vHeight;
uniform float uHeightScale;
out vec4 outColor;
void main() {
  // Lifted paper casts a lighter shadow.
  float strength = mix(1.0, 0.5, smoothstep(0.0, 0.45, vHeight));
  outColor = vec4(strength, clamp(vHeight / uHeightScale, 0.0, 1.0), 0.0, 1.0);
}`;

const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 outColor;
void main() {
  // 9-tap Gaussian via 5 bilinear samples; G (height) passes through unblurred.
  vec4 center = texture(uTex, vUv);
  float r = center.r * 0.2270270270;
  vec2 o1 = uStep * 1.3846153846;
  vec2 o2 = uStep * 3.2307692308;
  r += texture(uTex, vUv + o1).r * 0.3162162162;
  r += texture(uTex, vUv - o1).r * 0.3162162162;
  r += texture(uTex, vUv + o2).r * 0.0702702703;
  r += texture(uTex, vUv - o2).r * 0.0702702703;
  outColor = vec4(r, center.g, 0.0, 1.0);
}`;

const GROUND_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uMask;
uniform vec3 uShadowColor;
uniform float uOpacity;
out vec4 outColor;
void main() {
  float a = texture(uMask, vUv).r * uOpacity;
  outColor = vec4(uShadowColor * a, a);
}`;

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private readonly paper: Program;
  private readonly mask: Program;
  private readonly blur: Program;
  private readonly ground: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly posBuf: WebGLBuffer;
  private readonly nrmBuf: WebGLBuffer;
  private readonly uvBuf: WebGLBuffer;
  private readonly sideBuf: WebGLBuffer;
  private readonly idxBuf: WebGLBuffer;
  private indexCount = 0;
  private indexType: number;
  private front: WebGLTexture;
  private back: WebGLTexture;
  private targets: [Target, Target] | null = null;
  private maskW = 0;
  private maskH = 0;
  private readonly anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null;
  /** Shadow tint (sRGB, 0..1). */
  shadowColor: [number, number, number] = [0.36, 0.16, 0.2];
  shadowOpacity = 0.34;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      powerPreference: 'default',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    this.paper = makeProgram(gl, PAPER_VS, PAPER_FS, [
      'uViewProj', 'uLayerBias', 'uFolded', 'uFront', 'uBack', 'uMask', 'uLight', 'uShadowShift', 'uLift', 'uHeightScale', 'uCrease',
    ]);
    this.mask = makeProgram(gl, MASK_VS, MASK_FS, ['uViewProj', 'uShadowShift', 'uLift', 'uHeightScale']);
    this.blur = makeProgram(gl, FULLSCREEN_VS, BLUR_FS, ['uTex', 'uStep']);
    this.ground = makeProgram(gl, FULLSCREEN_VS, GROUND_FS, ['uMask', 'uShadowColor', 'uOpacity']);

    this.vao = gl.createVertexArray()!;
    this.emptyVao = gl.createVertexArray()!;
    this.posBuf = gl.createBuffer()!;
    this.nrmBuf = gl.createBuffer()!;
    this.uvBuf = gl.createBuffer()!;
    this.sideBuf = gl.createBuffer()!;
    this.idxBuf = gl.createBuffer()!;
    this.indexType = gl.UNSIGNED_SHORT;
    this.front = this.makeTexture();
    this.back = this.makeTexture();

    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    this.anisotropy = ext
      ? { ext, max: Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) }
      : null;
  }

  /** `sides`: per vertex, (in the top half, in the right half) as 0/1. */
  setMesh(vertexCount: number, uvs: Float32Array, sides: Float32Array, indices: Uint16Array | Uint32Array): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vertexCount * 12, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vertexCount * 12, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.sideBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sides, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = indices.length;
    this.indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }

  private makeTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 250, 240, 255]));
    return tex;
  }

  setTextures(front: TexImageSource, back: TexImageSource): void {
    this.upload(this.front, front);
    this.upload(this.back, back);
  }

  private upload(tex: WebGLTexture, source: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisotropy) {
      gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.ext.TEXTURE_MAX_ANISOTROPY_EXT, this.anisotropy.max);
    }
  }

  /** Size the drawing buffer. `cssW`/`cssH` in CSS px, `scale` = device px per CSS px. */
  resize(cssW: number, cssH: number, scale: number): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    // The shadow mask only needs about half CSS resolution: it gets blurred.
    const mw = Math.max(16, Math.ceil(cssW / 2));
    const mh = Math.max(16, Math.ceil(cssH / 2));
    if (mw === this.maskW && mh === this.maskH && this.targets) return;
    this.maskW = mw;
    this.maskH = mh;
    if (this.targets) {
      for (const t of this.targets) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
    }
    this.targets = [this.makeTarget(mw, mh), this.makeTarget(mw, mh)];
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  draw(
    camera: Camera,
    positions: Float32Array,
    normals: Float32Array,
    crease: [number, number],
    folded: [number, number],
  ): void {
    const gl = this.gl;
    if (!this.targets) return;
    const [ta, tb] = this.targets;
    const shift: [number, number] = [LIGHT[0] / LIGHT[1], LIGHT[2] / LIGHT[1]];

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, normals);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // 1. Shadow mask.
    gl.bindFramebuffer(gl.FRAMEBUFFER, ta.fbo);
    gl.viewport(0, 0, this.maskW, this.maskH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.useProgram(this.mask.program);
    gl.uniformMatrix4fv(this.mask.uniforms.uViewProj, false, camera.viewProj);
    gl.uniform2f(this.mask.uniforms.uShadowShift, shift[0], shift[1]);
    gl.uniform1f(this.mask.uniforms.uLift, SHADOW_LIFT);
    gl.uniform1f(this.mask.uniforms.uHeightScale, HEIGHT_SCALE);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);

    // 2. Blur.
    gl.useProgram(this.blur.program);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.blur.uniforms.uTex, 0);
    for (let pass = 0; pass < 2; pass++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, tb.fbo);
      gl.bindTexture(gl.TEXTURE_2D, ta.tex);
      gl.uniform2f(this.blur.uniforms.uStep, (pass ? 2.2 : 1.1) / this.maskW, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, ta.fbo);
      gl.bindTexture(gl.TEXTURE_2D, tb.tex);
      gl.uniform2f(this.blur.uniforms.uStep, 0, (pass ? 2.2 : 1.1) / this.maskH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 3. Table shadow, then the paper.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.ground.program);
    gl.bindTexture(gl.TEXTURE_2D, ta.tex);
    gl.uniform1i(this.ground.uniforms.uMask, 0);
    gl.uniform3f(this.ground.uniforms.uShadowColor, ...this.shadowColor);
    gl.uniform1f(this.ground.uniforms.uOpacity, this.shadowOpacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.paper.program);
    const u = this.paper.uniforms;
    gl.uniformMatrix4fv(u.uViewProj, false, camera.viewProj);
    gl.uniform3f(u.uLight, LIGHT[0], LIGHT[1], LIGHT[2]);
    gl.uniform2f(u.uShadowShift, shift[0], shift[1]);
    gl.uniform1f(u.uLift, SHADOW_LIFT);
    gl.uniform1f(u.uHeightScale, HEIGHT_SCALE);
    gl.uniform2f(u.uCrease, crease[0], crease[1]);
    gl.uniform1f(u.uLayerBias, LAYER_BIAS);
    gl.uniform2f(u.uFolded, folded[0], folded[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.front);
    gl.uniform1i(u.uFront, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.back);
    gl.uniform1i(u.uBack, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ta.tex);
    gl.uniform1i(u.uMask, 2);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    const gl = this.gl;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function makeProgram(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]): Program {
  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`Shader error: ${gl.getShaderInfoLog(sh)}`);
    }
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program error: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms: Program['uniforms'] = {};
  for (const n of names) uniforms[n] = gl.getUniformLocation(program, n);
  return { program, uniforms };
}
