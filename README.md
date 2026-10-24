# Bay Map Builder

Draw a clinic's treatment rooms (walls, curved walls, doors, windows, curtains, recliner bays, side tables, counters) and save the
map to ESK Tracker, so the tracker's bay map matches the clinic. Made for practice leads: draw the rooms, drop the bays, check Preview.
Chairs, side tables, lanterns, bay labels and curtain links are placed automatically, so a map rarely needs fine tuning.

A bay map holds no patient data. Keep it that way: no names, no MRNs, nothing but rooms and bay numbers.

## How a practice lead uses it

1. ESK Tracker › Settings › Bay map › **Edit in the Bay Map Builder** (or open the page on its own).
2. Pick a template, or draw rooms with **Room (R)**. Add doors with **Door (D)**, then bays with **Bay (B)**.
3. Clear the checklist on the right, check **Preview**, then **Save to tracker**. Opened on its own, use **Download file**, then in
   ESK Tracker › Settings › Bay map choose **Load a map file**.

Have a floor plan? **Trace image** opens a PNG or JPG to draw over (a PDF has to be saved as a picture first). **Set scale** makes
it match real sizes. The picture stays in the browser: it isn't uploaded and isn't put in the map file.

Work is kept in the browser as you go (`localStorage` key `bmDraft`), so closing the page loses nothing. **?** lists the shortcuts.

Rooms drawn side by side share one wall, so a door between them cuts the only wall there. Drag the round handle in the middle of a
wall to curve it. Preview draws the map with the tracker's own code and CSS at three widths (Wide, Task pane, ESK Bays), light or
dark, with made-up visits on the bays.

## How it reaches the tracker

Opened as `?from=esk`, the page talks to the tracker: as an Office dialog through `messageParent` and
`DialogParentMessageReceived` (chunked like ESK's `sendChunks`/`makeRx`), or as a frame on the tracker's page through
`postMessage` (same origin only). Messages: `bmReady` → `bmLoad {plan, bays}` → `bmSave {plan}` → `bmSaved {ok, err?, warn?}`, and
`bmClose`. office.js is only loaded for the dialog case: inside a frame on the tracker's page it navigates the frame away.

The file is JSON, schema `mhs-bay-map` v 1. `render.js` holds the renderer and validator (`bpCheck`) shared with ESK Tracker
(`src/taskpane.html`). The block between the `==== bay plan` markers must stay byte-identical in both. The file also carries the
builder's own model (`edit`) so a saved map reopens exactly. The tracker ignores it.

## Files

- `render.js`: the shared renderer and validator (copy of the ESK block).
- `core.js`: the model, geometry, automatic placement, checks, import and export. No DOM: works in the page (global `BM`, load
  after `render.js`) and in Node (`require('./core.js')`).
- `index.html`: the page (UI and CSS). Its `tok`, `base`, `ctl` and `eskMap` style blocks are copied line for line from the
  tracker so the builder and its Preview look the same; copy them again when the tracker's look changes.
- `assets/fonts`: IBM Plex Sans (see `assets/fonts/LICENSE`).

## Tests

Plain Node, no packages:

```
node tests/core.test.js
node tests/render.test.js
node tests/page.test.js
```

`BM_SHARED="…/esk-tracker/src/taskpane.html"` also checks that the tracker's copy of the shared block matches (`render.test.js`), and
that the page's copied CSS and chunking code still match the tracker (`page.test.js`).
