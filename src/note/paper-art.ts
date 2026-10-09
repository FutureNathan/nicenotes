/**
 * Drawing the stationery. All layout is in units of the paper's width, so the
 * same numbers drive the DOM compose card and the 3D paper's texture.
 */

export interface PaperStyle {
  id: string;
  label: string;
  paper: string;
  back: string;
  line: string;
  margin: string;
  ink: string;
  fiber: string;
}

export const STYLES: PaperStyle[] = [
  {
    id: 'cream',
    label: 'Cream',
    paper: '#fffaf0',
    back: '#f8f0e1',
    line: '#cfe0ee',
    margin: '#f3aebd',
    ink: '#28386b',
    fiber: '#b59f7c',
  },
  {
    id: 'blush',
    label: 'Blush',
    paper: '#ffe8ec',
    back: '#fadce2',
    line: '#f5c3ce',
    margin: '#e98aa1',
    ink: '#7c2547',
    fiber: '#c48a96',
  },
  {
    id: 'mint',
    label: 'Mint',
    paper: '#e7f6ec',
    back: '#dcefe3',
    line: '#bde2cb',
    margin: '#8acba5',
    ink: '#1d5444',
    fiber: '#86a894',
  },
  {
    id: 'sky',
    label: 'Sky',
    paper: '#e8f1ff',
    back: '#dde8f8',
    line: '#c2d7f4',
    margin: '#8fb0e6',
    ink: '#223d78',
    fiber: '#8ea0bf',
  },
  {
    id: 'lilac',
    label: 'Lilac',
    paper: '#f1eaff',
    back: '#e7def8',
    line: '#d8caf4',
    margin: '#b39be5',
    ink: '#4a2c80',
    fiber: '#a196bf',
  },
];

export const PAPER_ASPECT = 1.25;
export const PAD_X = 0.11;
export const MARGIN_X = 0.075;
export const HANDWRITING = '"Caveat", "Bradley Hand", "Segoe Print", cursive';
export const HAND_WEIGHT = 500;
export const MAX_MESSAGE = 280;
export const MAX_NAME = 24;

const SIZES = [0.092, 0.08, 0.07, 0.062, 0.055, 0.049, 0.044];
const LINE_RATIO = 1.32;
const TOP = 0.085;
const BOTTOM = 0.07;

export interface NoteLayout {
  /** Font size, as a fraction of the paper width. */
  fontSize: number;
  lineHeight: number;
  /** Baseline of the first ruled line (fraction of width, from the top). */
  firstBaseline: number;
  /** Number of body lines that fit above the signature line. */
  bodyLines: number;
  /** Baseline of the signature ("from") line. */
  fromBaseline: number;
  lines: string[];
  overflow: boolean;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    measureCtx = c.getContext('2d')!;
  }
  return measureCtx;
}

export function handFont(px: number): string {
  return `${HAND_WEIGHT} ${px}px ${HANDWRITING}`;
}

/** Greedy word wrap that mirrors how a textarea with pre-wrap breaks lines. */
export function wrapText(text: string, fontSize: number): string[] {
  const ctx = measurer();
  const scale = 1000;
  ctx.font = handFont(fontSize * scale);
  const maxW = (1 - 2 * PAD_X) * scale;
  const width = (s: string) => ctx.measureText(s).width;
  const out: string[] = [];
  let line = '';
  // Start a line with `word`, breaking it by characters if it's too long.
  const startWith = (word: string) => {
    if (width(word) <= maxW) {
      line = word;
      return;
    }
    let chunk = '';
    for (const ch of Array.from(word)) {
      if (chunk && width(chunk + ch) > maxW) {
        out.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    line = chunk;
  };
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    startWith(words[0]);
    for (let w = 1; w < words.length; w++) {
      const candidate = `${line} ${words[w]}`;
      // Trailing spaces hang off the end of a line, like in a textarea.
      if (width(candidate.trimEnd()) <= maxW) {
        line = candidate;
      } else {
        out.push(line);
        startWith(words[w]);
      }
    }
    out.push(line);
  }
  return out;
}

export function layoutNote(message: string): NoteLayout {
  const text = message.replace(/\r/g, '');
  let last: NoteLayout | null = null;
  for (const fontSize of SIZES) {
    const lineHeight = fontSize * LINE_RATIO;
    const firstBaseline = TOP + fontSize;
    const totalLines = Math.floor((PAPER_ASPECT - BOTTOM - firstBaseline) / lineHeight) + 1;
    const bodyLines = totalLines - 1;
    const fromBaseline = firstBaseline + bodyLines * lineHeight;
    const lines = text.length ? wrapText(text, fontSize) : [];
    last = { fontSize, lineHeight, firstBaseline, bodyLines, fromBaseline, lines, overflow: lines.length > bodyLines };
    if (!last.overflow) return last;
  }
  return last!;
}

/** Vertical metrics for lining DOM text up with the ruled lines. */
export function fontMetrics(fontPx: number): { ascent: number; descent: number } {
  const ctx = measurer();
  ctx.font = handFont(fontPx);
  const m = ctx.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent ?? fontPx * 0.8;
  const descent = m.fontBoundingBoxDescent ?? fontPx * 0.25;
  return { ascent, descent };
}

let noiseTile: HTMLCanvasElement | null = null;
function noise(): HTMLCanvasElement {
  if (noiseTile) return noiseTile;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 200 + Math.random() * 55;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  noiseTile = c;
  return c;
}

/** Paper colour, fibres and grain. */
function paintStock(ctx: CanvasRenderingContext2D, w: number, h: number, base: string, fiber: string, seed: number): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = ctx.createPattern(noise(), 'repeat')!;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // A few faint fibres.
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  ctx.save();
  ctx.strokeStyle = fiber;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.07;
  ctx.lineWidth = Math.max(1, w * 0.0012);
  for (let i = 0; i < 90; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const a = rand() * Math.PI * 2;
    const len = w * (0.008 + rand() * 0.02);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(a + 0.6) * len * 0.5,
      y + Math.sin(a + 0.6) * len * 0.5,
      x + Math.cos(a) * len,
      y + Math.sin(a) * len,
    );
    ctx.stroke();
  }
  ctx.restore();

  // Slightly darker edges, like real stock.
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.hypot(w, h) * 0.55);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(90,60,40,0.06)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function heart(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.35);
  ctx.bezierCurveTo(x - size * 0.05, y + size * 0.2, x - size * 0.5, y + size * 0.05, x - size * 0.5, y - size * 0.18);
  ctx.bezierCurveTo(x - size * 0.5, y - size * 0.45, x - size * 0.12, y - size * 0.52, x, y - size * 0.25);
  ctx.bezierCurveTo(x + size * 0.12, y - size * 0.52, x + size * 0.5, y - size * 0.45, x + size * 0.5, y - size * 0.18);
  ctx.bezierCurveTo(x + size * 0.5, y + size * 0.05, x + size * 0.05, y + size * 0.2, x, y + size * 0.35);
  ctx.closePath();
}

export interface FrontContent {
  layout: NoteLayout;
  /** Whether to draw the message and signature (false for the compose card). */
  withText: boolean;
  from: string;
}

/** The written side: ruled lines, margin, doodle and (optionally) the note. */
export function paintFront(canvas: HTMLCanvasElement, style: PaperStyle, content: FrontContent): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const { layout } = content;
  paintStock(ctx, w, h, style.paper, style.fiber, 1234);

  // Ruled lines sit just under each baseline.
  ctx.save();
  ctx.strokeStyle = style.line;
  ctx.lineWidth = Math.max(1, w * 0.0022);
  for (let k = 0; k <= layout.bodyLines; k++) {
    const y = Math.round((layout.firstBaseline + k * layout.lineHeight + layout.fontSize * 0.14) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.strokeStyle = style.margin;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = Math.max(1, w * 0.0024);
  const mx = Math.round(MARGIN_X * w) + 0.5;
  ctx.beginPath();
  ctx.moveTo(mx, 0);
  ctx.lineTo(mx, h);
  ctx.stroke();
  ctx.restore();

  // A tiny doodled heart in the corner.
  ctx.save();
  ctx.strokeStyle = style.margin;
  ctx.lineWidth = Math.max(1.5, w * 0.004);
  ctx.lineJoin = 'round';
  heart(ctx, w * 0.9, w * 0.055, w * 0.045);
  ctx.stroke();
  ctx.restore();

  if (!content.withText) return;

  ctx.save();
  ctx.fillStyle = style.ink;
  ctx.globalAlpha = 0.93;
  ctx.font = handFont(layout.fontSize * w);
  ctx.textBaseline = 'alphabetic';
  const lines = layout.lines.slice(0, layout.bodyLines);
  lines.forEach((line, k) => {
    ctx.fillText(line, PAD_X * w, (layout.firstBaseline + k * layout.lineHeight) * w);
  });
  const from = content.from.trim();
  if (from) {
    ctx.textAlign = 'right';
    ctx.fillText(`— ${from}`, (1 - PAD_X) * w, layout.fromBaseline * w);
  }
  ctx.restore();
}

/**
 * The outside. After both folds, the back of the bottom-right quarter faces up
 * (mirrored left-right), so that's where the "for ..." label goes.
 */
export function paintBack(canvas: HTMLCanvasElement, style: PaperStyle, to: string): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  paintStock(ctx, w, h, style.back, style.fiber, 4321);

  ctx.save();
  ctx.translate(w * 0.75, h * 0.75);
  ctx.scale(-1, 1);
  const name = to.trim();
  const label = name ? `for ${name}` : 'for you';
  let size = w * 0.085;
  ctx.font = handFont(size);
  while (ctx.measureText(label).width > w * 0.4 && size > w * 0.04) {
    size *= 0.92;
    ctx.font = handFont(size);
  }
  ctx.fillStyle = style.ink;
  ctx.globalAlpha = 0.9;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, 0, -h * 0.01);

  // A little heart sticker under the name.
  ctx.globalAlpha = 1;
  const s = w * 0.07;
  ctx.fillStyle = style.margin;
  heart(ctx, 0, h * 0.075, s);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  heart(ctx, -s * 0.12, h * 0.075 - s * 0.08, s * 0.35);
  ctx.fill();
  ctx.restore();
}
