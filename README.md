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

## How it reaches the tracker

The file is JSON, schema `mhs-bay-map` v 1. `render.js` holds the renderer and validator (`bpCheck`) shared with ESK Tracker
(`src/taskpane.html`). The block between the `==== bay plan` markers must stay byte-identical in both. The file also carries the
builder's own model (`edit`) so a saved map reopens exactly. The tracker ignores it.

## Files

- `render.js`: the shared renderer and validator (copy of the ESK block).
- `core.js`: the model, geometry, automatic placement, checks, import and export. No DOM: works in the page (global `BM`, load
  after `render.js`) and in Node (`require('./core.js')`).
- `index.html`: the page.
- `assets/fonts`: IBM Plex Sans (see `assets/fonts/LICENSE`).

## Tests

Plain Node, no packages:

```
node tests/core.test.js
node tests/render.test.js
```

`BM_SHARED="…/esk-tracker/src/taskpane.html"` makes `render.test.js` also check that the shared block in the tracker matches.
