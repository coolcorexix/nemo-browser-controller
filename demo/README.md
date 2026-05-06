# Demo: rect-align challenge

A live run of an LLM driving the browser controller to read DOM layout, edit
CSS, and verify the result with screenshots — end-to-end through the MCP
server, the extension, and the bundled `test-app/`.

## The challenge

`test-app/` renders a CSS grid of six cells. One cell (`.blue-rect`) is filled
blue at grid slot 5. A second element (`.red-rect`) is `position: absolute`
with intentionally wrong `top` / `left` / `width` / `height`. The model has
to make red exactly overlay blue.

The grid uses `1fr` columns, so the blue cell's pixel width depends on the
page width at run time — the model can't hard-code anything from the CSS
source, it has to read the rendered layout.

The expected loop:

1. `browser_screenshot` — see the misalignment.
2. `browser_query` for `.blue-rect` and `.red-rect` — read both bounding boxes.
3. Edit `test-app/src/style.css` so `.red-rect`'s `top` / `left` / `width` /
   `height` match `.blue-rect`'s rendered position.
4. Vite HMR reloads — `browser_screenshot` again to confirm.

## Demo

<video src="rect-align-challenge.mp4" controls width="800"></video>

[Download MP4](rect-align-challenge.mp4) — 20s, 2.3 MB, sped up 12.98×
from the original screen recording.

**Agent:** Claude Code Opus 4.7 (1M context).

## Result

The model converged on these CSS deltas in `test-app/src/style.css`:

| Property | From    | To      |
| -------- | ------- | ------- |
| `top`    | `50px`  | `276px` |
| `left`   | `40px`  | `286px` |
| `width`  | `120px` | `250px` |
| `height` | `80px`  | `140px` |

After the edit, `browser_query` reports both rectangles at the same bbox —
`(310, 316) 250×140` — pixel-perfect overlap.

## Notes from this run

- `browser_inspect` timed out (30 s) on this attempt; the model fell back to
  the bbox returned by `browser_query`, which carries the same x/y/w/h.
- The first edit used values measured at a wider viewport. After Vite
  reloaded, the `1fr` columns had a smaller width, so red overshot. A
  second `browser_query` gave the correct numbers.
- Re-querying after each layout change is cheaper than guessing.
