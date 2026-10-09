import '@fontsource/caveat/500.css';
import '@fontsource-variable/nunito';
import './style.css';

import { canLock, decodeFragment, encodeLockedNote, encodeNote, isExpired, type Note } from './note/codec';
import {
  fontMetrics,
  handFont,
  HAND_WEIGHT,
  HANDWRITING,
  layoutNote,
  PAD_X,
  paintBack,
  paintFront,
  STYLES,
  type NoteLayout,
} from './note/paper-art';
import { Scene } from './scene';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const EXPIRY = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '1 week', seconds: 7 * 86400 },
  { label: 'never', seconds: 0 },
];

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fontsReady = Promise.all([document.fonts.load(handFont(40)), document.fonts.ready]).catch(() => undefined);

let styleIndex = 0;
let expiryIndex = 1;
let secretOn = false;
let lastValid = '';
let lastArtKey = '';
let scene: Scene | null = null;
let sceneFailed = false;

type View = 'compose' | 'stage' | 'lock' | 'notice';

function showView(view: View): void {
  for (const v of ['compose', 'stage', 'lock', 'notice'] as View[]) $(v).hidden = v !== view;
  document.body.classList.toggle('staged', view === 'stage');
  if (view !== 'stage') scene?.pause();
}

function getScene(): Scene | null {
  if (scene || sceneFailed) return scene;
  try {
    scene = new Scene($<HTMLCanvasElement>('scene'));
    scene.reducedMotion = reducedMotion;
  } catch (err) {
    console.warn('3D unavailable, using the flat note instead', err);
    sceneFailed = true;
  }
  return scene;
}

let toastTimer = 0;
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
}

function shake(el: HTMLElement): void {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function safeAreaBottom(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;height:env(safe-area-inset-bottom,0px);visibility:hidden';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}

function stageInsets(s: Scene): void {
  const top = $('stageTitle').getBoundingClientRect().bottom + 10;
  s.insets = { top: Math.max(70, top), bottom: 150 + safeAreaBottom(), side: 18 };
  s.resize();
}

// Reused: iOS is slow to give canvas memory back.
const texFront = document.createElement('canvas');
const texBack = document.createElement('canvas');

function textures(note: Note): [HTMLCanvasElement, HTMLCanvasElement] {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const cssW = Math.min(window.innerWidth - 32, 460);
  const tw = Math.max(768, Math.min(1600, Math.round((cssW * dpr * 1.15) / 64) * 64));
  const style = STYLES[note.style] ?? STYLES[0];
  for (const c of [texFront, texBack]) {
    c.width = tw;
    c.height = Math.round(tw * 1.25);
  }
  paintFront(texFront, style, { layout: layoutNote(note.message), withText: true, from: note.from });
  paintBack(texBack, style, note.to);
  return [texFront, texBack];
}

/** A flat picture of the note, for when there's no 3D. */
function flatNote(note: Note): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 800;
  c.height = 1000;
  paintFront(c, STYLES[note.style] ?? STYLES[0], { layout: layoutNote(note.message), withText: true, from: note.from });
  return c;
}

function setStage(title: string, hint: string, fine = ''): void {
  $('stageTitle').textContent = title;
  $('stageHint').textContent = hint;
  $('stageFine').textContent = fine;
}

function setActions(...buttons: HTMLElement[]): void {
  $('stageActions').replaceChildren(...buttons);
}

function button(label: string, kind: 'primary' | 'secondary', onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = kind;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function describeExpiry(note: Note): string {
  if (note.expiresAt === null) return 'this one is yours to keep';
  const s = note.expiresAt - Date.now() / 1000;
  if (s < 90 * 60) return `fades in about ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 36 * 3600) return `fades in about ${Math.round(s / 3600)} hours`;
  return `fades in about ${Math.round(s / 86400)} days`;
}

// ------------------------------------------------------------------ compose

function buildCompose(): void {
  const swatches = $('swatches');
  STYLES.forEach((style, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `${style.label} paper`);
    b.style.setProperty('--c', style.paper);
    b.addEventListener('click', () => setStyle(i));
    swatches.appendChild(b);
  });
  const chips = $('expiry');
  EXPIRY.forEach((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.textContent = e.label;
    b.addEventListener('click', () => setExpiry(i));
    chips.appendChild(b);
  });
  setStyle(styleIndex);
  setExpiry(expiryIndex);

  const toggle = $('secretToggle');
  if (!canLock()) toggle.hidden = true;
  toggle.addEventListener('click', () => {
    secretOn = !secretOn;
    toggle.setAttribute('aria-expanded', String(secretOn));
    $('secretFields').hidden = !secretOn;
    if (secretOn) $('secret').focus();
  });

  const message = $<HTMLTextAreaElement>('message');
  message.addEventListener('input', () => {
    // Keep the note on one page: refuse input that would overflow it.
    const layout = layoutNote(message.value);
    if (layout.overflow && message.value.length > lastValid.length) {
      const caret = message.selectionStart - (message.value.length - lastValid.length);
      message.value = lastValid;
      message.setSelectionRange(caret, caret);
      shake($('card'));
      return;
    }
    lastValid = message.value;
    layoutCard(layout);
  });
  $<HTMLInputElement>('from').addEventListener('input', sizeFrom);
  $('foldBtn').addEventListener('click', () => void foldAndSend());
  window.addEventListener('resize', () => {
    if (!$('compose').hidden) layoutCard();
  });
}

function setStyle(i: number): void {
  styleIndex = i;
  $('swatches')
    .querySelectorAll('.swatch')
    .forEach((b, k) => b.setAttribute('aria-checked', String(k === i)));
  layoutCard();
}

function setExpiry(i: number): void {
  expiryIndex = i;
  $('expiry')
    .querySelectorAll('.chip')
    .forEach((b, k) => b.setAttribute('aria-checked', String(k === i)));
}

/** Line the textarea and signature up with the ruled lines drawn on the card. */
function layoutCard(layout: NoteLayout = layoutNote($<HTMLTextAreaElement>('message').value)): void {
  const card = $('card');
  const W = card.clientWidth;
  if (!W) return;
  const style = STYLES[styleIndex];
  const fontPx = layout.fontSize * W;
  const lh = layout.lineHeight * W;
  const { ascent, descent } = fontMetrics(fontPx);
  const above = (lh - (ascent + descent)) / 2 + ascent;

  const ta = $('message');
  ta.style.left = `${PAD_X * W}px`;
  ta.style.width = `${(1 - 2 * PAD_X) * W}px`;
  ta.style.top = `${layout.firstBaseline * W - above}px`;
  ta.style.height = `${layout.bodyLines * lh}px`;
  ta.style.fontSize = `${fontPx}px`;
  ta.style.lineHeight = `${lh}px`;

  const from = $('fromRow');
  from.style.right = `${PAD_X * W}px`;
  from.style.top = `${layout.fromBaseline * W - above}px`;
  from.style.height = `${lh}px`;
  from.style.fontSize = `${fontPx}px`;
  from.style.lineHeight = `${lh}px`;
  from.style.maxWidth = `${(1 - 2 * PAD_X) * W}px`;
  $('from').style.height = `${lh}px`;
  $('from').style.lineHeight = `${lh}px`;

  card.style.setProperty('--note-ink', style.ink);
  const key = `${W}|${styleIndex}|${layout.fontSize}`;
  if (key !== lastArtKey) {
    lastArtKey = key;
    const art = $<HTMLCanvasElement>('cardArt');
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    art.width = Math.round(W * dpr);
    art.height = Math.round(W * 1.25 * dpr);
    paintFront(art, style, { layout, withText: false, from: '' });
  }
  sizeFrom();
}

let measure: CanvasRenderingContext2D | null = null;
function sizeFrom(): void {
  const input = $<HTMLInputElement>('from');
  const px = parseFloat($('fromRow').style.fontSize) || 24;
  measure ??= document.createElement('canvas').getContext('2d')!;
  measure.font = `${HAND_WEIGHT} ${px}px ${HANDWRITING}`;
  const w = measure.measureText(input.value || input.placeholder).width;
  input.style.width = `${Math.ceil(w + px * 0.3)}px`;
}

function openCompose(prefill: Partial<Note> = {}): void {
  document.body.classList.remove('folding');
  showView('compose');
  if (prefill.to !== undefined) $<HTMLInputElement>('to').value = prefill.to;
  $<HTMLButtonElement>('foldBtn').disabled = false;
  window.scrollTo(0, 0);
  void fontsReady.then(() => {
    lastArtKey = '';
    layoutCard();
  });
}

function currentNote(): Note {
  const seconds = EXPIRY[expiryIndex].seconds;
  return {
    message: $<HTMLTextAreaElement>('message').value.replace(/\s+$/, ''),
    from: $<HTMLInputElement>('from').value.trim(),
    to: $<HTMLInputElement>('to').value.trim(),
    style: styleIndex,
    expiresAt: seconds ? Math.floor(Date.now() / 1000) + seconds : null,
  };
}

async function foldAndSend(): Promise<void> {
  const note = currentNote();
  if (!note.message.trim()) {
    shake($('card'));
    $('message').focus();
    return;
  }
  const secret = $<HTMLInputElement>('secret').value;
  if (secretOn && !secret.trim()) {
    shake($('secretFields'));
    $('secret').focus();
    return;
  }
  const btn = $<HTMLButtonElement>('foldBtn');
  btn.disabled = true;
  const fragment = secretOn
    ? encodeLockedNote(note, secret, $<HTMLInputElement>('hint').value)
    : Promise.resolve(encodeNote(note));

  // Let the keyboard get out of the way before we measure the card.
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) {
    active.blur();
    await new Promise((r) => setTimeout(r, 380));
  }
  await fontsReady;

  const s = getScene();
  if (!s) {
    showSent(`${location.origin}/#${await fragment}`, note, null);
    return;
  }
  const [front, back] = textures(note);
  s.setTextures(front, back);
  s.onPhase = null;
  s.onTouch = null;
  const rect = $('card').getBoundingClientRect();
  document.body.classList.add('folding');
  setStage('', '');
  setActions();
  $('stage').hidden = false;
  stageInsets(s);
  s.resume();
  const folded = s.foldFrom({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  // The 3D paper now sits exactly over the card: crossfade, then drop the card.
  requestAnimationFrame(() => {
    document.body.classList.add('staged');
    setTimeout(() => {
      $('compose').hidden = true;
      document.body.classList.remove('folding');
    }, 380);
  });
  const [link] = await Promise.all([fragment, folded]);
  showSent(`${location.origin}/#${link}`, note, s);
}

function showSent(url: string, note: Note, s: Scene | null): void {
  if (!s) {
    showView('notice');
    $('noticeEmoji').textContent = '💌';
    $('noticeTitle').textContent = 'your note is ready';
    $('noticeText').textContent = 'Send them the link. The note lives only inside it.';
    $('noticeCard').replaceChildren(flatNote(note));
    const action = $<HTMLAnchorElement>('noticeAction');
    action.textContent = 'send it';
    action.onclick = (e) => {
      e.preventDefault();
      void share(url);
    };
    return;
  }
  showView('stage');
  setStage('folded up with love', '', describeExpiry(note));
  setActions(
    button('send it 💌', 'primary', () => void share(url)),
    button('copy link', 'secondary', () => void copy(url)),
  );
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'link';
  edit.textContent = 'edit';
  edit.addEventListener('click', () => openCompose());
  $('stageFine').append(' · ', edit);
}

async function share(url: string): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'a little note for you ♡', url });
      toast('sent ♡');
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }
  }
  await copy(url);
}

async function copy(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('link copied ♡');
}

// ------------------------------------------------------------------ receive

function notice(emoji: string, title: string, text: string, action = 'write a note'): void {
  showView('notice');
  $('noticeEmoji').textContent = emoji;
  $('noticeTitle').textContent = title;
  $('noticeText').textContent = text;
  $('noticeCard').replaceChildren();
  const a = $<HTMLAnchorElement>('noticeAction');
  a.textContent = action;
  a.onclick = (e) => {
    e.preventDefault();
    history.pushState(null, '', '/');
    openCompose();
  };
}

async function receive(note: Note): Promise<void> {
  if (isExpired(note)) {
    notice('🍂', 'this note has faded away', 'It was only meant to last a little while. Maybe write one back?', 'write one back');
    return;
  }
  await fontsReady;
  const s = getScene();
  if (!s) {
    notice('💌', note.to ? `a note for ${note.to}` : 'a little note for you', describeExpiry(note), 'write one back');
    $('noticeCard').replaceChildren(flatNote(note));
    $('sr').textContent = note.message;
    return;
  }
  const [front, back] = textures(note);
  s.setTextures(front, back);
  showView('stage');
  setStage("you've got a little note ♡", 'tap it, or pull the corner', '');
  setActions();
  stageInsets(s);
  s.resume();
  s.onTouch = () => setStage('', '', '');
  s.onPhase = (phase) => {
    if (phase !== 'open') return;
    $('sr').textContent = `${note.message}${note.from ? `, from ${note.from}` : ''}`;
    setStage('', '', describeExpiry(note));
    setActions(
      button('write one back ♡', 'primary', () => {
        history.pushState(null, '', '/');
        openCompose({ to: note.from });
      }),
    );
  };
  s.presentFolded();
}

function showLock(hint: string, unlock: (secret: string) => Promise<Note | null>): void {
  showView('lock');
  $('lockHint').textContent = hint ? `hint: ${hint}` : 'Ask the person who sent it.';
  $('lockError').textContent = '';
  const form = $<HTMLFormElement>('lockForm');
  const input = $<HTMLInputElement>('lockInput');
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    const submit = form.querySelector('button')!;
    submit.disabled = true;
    submit.textContent = 'opening…';
    const note = await unlock(input.value);
    submit.disabled = false;
    submit.textContent = 'open it';
    if (!note) {
      $('lockError').textContent = "that's not quite it";
      shake(form);
      input.select();
      return;
    }
    input.blur();
    void receive(note);
  };
}

// ------------------------------------------------------------------- route

function route(): void {
  const hash = location.hash.slice(1);
  if (!hash) {
    openCompose();
    return;
  }
  const decoded = decodeFragment(hash);
  if (decoded.kind === 'invalid') {
    notice('🫧', 'this link is a little crumpled', 'Part of it may have gone missing. Ask them to send it again?');
  } else if (decoded.kind === 'locked') {
    if (!canLock()) {
      notice('🔒', "this note can't be opened here", 'Locked notes need a secure (https) page.');
      return;
    }
    showLock(decoded.hint, decoded.unlock);
  } else {
    void receive(decoded.note);
  }
}

function init(): void {
  buildCompose();
  const about = $<HTMLDialogElement>('about');
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-about]')) about.showModal();
  });
  about.addEventListener('click', (e) => {
    if (e.target === about) about.close();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  route();
}

init();

if (import.meta.env.DEV) {
  (window as unknown as { __nn: unknown }).__nn = { scene: () => scene };
}
