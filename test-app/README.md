# Rectangle Alignment Test

A deliberately misaligned page used to exercise the Nemo browser controller.

## The task

`.blue-rect` lives inside a `display: grid` (cell #5 — bottom row, middle
column), so its rendered position depends on layout math, not on raw CSS
coordinates.

`.red-rect` is `position: absolute` with the wrong `top` / `left` /
`width` / `height`. The job is to **make the red rectangle overlay the blue
one exactly** — using only what the AI can observe through the Chrome
extension.

The AI cannot derive the answer from CSS alone — it has to look.

## Run

```bash
cd test-app
npm install
npm run dev
```

Then in Chrome: `http://localhost:5180`. Open the Nemo side panel.

(Port is set to 5180 in `vite.config.js` to avoid clashing with the typical
5173. Change it there if needed.)

## Suggested AI prompt

> Open localhost:5180. The red rectangle should be placed exactly on top of
> the blue rectangle, but it's misaligned. Use the browser tools to see what's
> happening and tell me which CSS values in test-app/src/style.css I need to
> change so red overlays blue precisely. Verify by screenshotting after.

The expected loop:

1. `browser_navigate` → `http://localhost:5180`
2. `browser_screenshot` → see the misalignment
3. `browser_query selector=".blue-rect"` → get a ref for blue
4. `browser_inspect ref=N` → read blue's `documentBbox` (the truth about its
   rendered position)
5. `browser_query selector=".red-rect"` → ref for red
6. `browser_inspect` red → see its current top/left/width/height
7. Edit `src/style.css` `.red-rect { top, left, width, height }`
8. Vite HMR reloads → `browser_screenshot` to verify the overlap.
