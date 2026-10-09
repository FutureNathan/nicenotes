# nice notes ♡

Tiny, private notes for the people you love. You write on a sheet of paper, it folds itself up, and you send the link.
They get a folded note on their screen that they unfold with their fingers.

Live at **note.yourswith.love**.

## How private is it?

- **The note lives only inside the link**, in the `#fragment`. Browsers never send the fragment to a server, so notes
  are never uploaded or stored anywhere. There is no backend and no database.
- **Secret word (optional):** the note is encrypted in the browser (PBKDF2-SHA256 → AES-256-GCM). Without the word, the
  link is noise. The hint is stored in the clear but authenticated.
- **No tracking:** no analytics, no third-party requests. Fonts are self-hosted, and there's a strict CSP plus
  `no-referrer` (see `vercel.json`).
- **"Fades after"** hides a note once its time has passed. Because the note is in the link, that's a gentle promise,
  not a guarantee. The app says so in "how it works".

## Run it

```sh
npm install
npm run dev        # http://localhost:5173 (also on your LAN, so you can open it on a phone)
npm test           # codec + physics tests
npm run build      # typecheck + production build into dist/
```

Secret words use WebCrypto, which needs a secure context. They work on `localhost` and on Vercel (https). They don't
work on a phone opening `http://192.168.x.x`, so try those on a Vercel preview deploy.

## Deploy (Vercel)

1. Import the repo in Vercel. It detects Vite: the build command is `npm run build` and the output is `dist`.
2. Add the domain `note.yourswith.love` under Project → Domains, then add the `CNAME` record Vercel shows you at your
   DNS provider.
3. That's it. `vercel.json` adds the security headers and long-lived caching for hashed assets.

Link previews (iMessage, WhatsApp…) use `public/og.png` via absolute URLs in `index.html`. Change them there if the
domain changes.

## How it works

```
src/
  main.ts             screens & flow: compose → fold → share; open link → (unlock) → unfold
  scene.ts            ties physics + rendering + touch together, camera framing, tap-to-open
  sim/paper.ts        the paper: small-step XPBD particle grid
  sim/fold.ts         analytic folding (the send animation and the folded pose) + the "virtual hand"
  gl/renderer.ts      WebGL2: paper, soft table shadow, shadows the paper casts on itself
  gl/camera.ts        top-down camera (the table maps 1:1 to a screen rectangle)
  note/paper-art.ts   stationery, handwriting layout (shared by the compose card and the 3D texture)
  note/codec.ts       link format and encryption
```

**Physics.** The sheet is a 16×20 grid of particles, solved with small-step XPBD (about 8 substeps per
frame):
- **No stretching:** distance constraints, plus *tethers* while a finger holds the paper. No point can end up
  farther from the finger than it is across the flat sheet, so the whole sheet follows at once.
- **Paper, not cloth:** curvature constraints keep it stiff, so it bends in big smooth curls.
- **Creases:** where the note was folded, the sheet becomes a weak hinge. It bends easily there, and the folded
  note stays folded under its own weight.
- **Layers:** folded layers rest on each other through "layer contacts". Where two bits of sheet overlap and both
  lie roughly flat, the pair remembers which is on top. Steep or crumpled bits don't take part, and a pair that's
  clearly stuck the other way round accepts it rather than fighting. Fighting constraints are what make
  simulations tremble.
- **Settling:** paper is a "dead" material. Internal damping kills wobbles, and once nobody is touching it the air
  thickens until it comes to rest and the simulation sleeps.
- **Tidy up:** a button floats the paper back to its neat pose (folded, or flat once opened).

**Smooth on phones.**
- The simulation advances by the real frame time, so 60/90/120 Hz screens all feel the same.
- Drawing stops completely once the paper is still, which saves battery and avoids thermal throttling.
- The device pixel ratio is capped at 2 and steps down if frames run long.
- The shadow pass renders at half CSS resolution.
- The JS bundle is about 19 KB gzipped.

## Ideas for later

- **True expiry / burn-after-reading and short links** would need a tiny backend (e.g. Supabase storing only
  ciphertext). A free Supabase project pauses after a week of inactivity, so pair it with a weekly Vercel Cron ping.
- Paper-plane "send" animation, crumpling, stickers and doodles, sound and haptics.
