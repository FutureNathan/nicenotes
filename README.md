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

**Physics.** The sheet is a grid of particles (24×30 normally, 16×20 on slower phones; it measures once and
remembers). Each frame runs about 8 XPBD substeps:
- Distance constraints keep the sheet from stretching.
- Curvature constraints make it stiff like paper.
- Creases are *plastic*: they remember the fold, give way when you open it, and leave a soft tent.
- Air drag acts along the surface normal, so the paper floats as it falls.
- Folded layers rest on each other through "layer contacts". Each nearby pair remembers which side of the sheet the
  other is on, so layers can be paper-thin without passing through each other.

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
