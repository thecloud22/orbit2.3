---
name: swimlane-diagram
description: Draw a swimlane diagram (rows for actors or systems, columns for time or phases) and export it as a PNG for Confluence, docs, slides or a README. Use when the user asks to draw, sketch, diagram or visualise a process, flow, timeline, incident, order lifecycle, deployment, handoff or "who does what when" as a swimlane, or wants an image of a flow.
---

# Swimlane diagrams

You write a small JSON spec. A script draws it and saves a PNG. Do not hand-draw SVG or invent your own style. The lanes, columns and boxes come from the user's subject, so this works for any process.

## Steps

1. **Write the timeline in plain text first.** Decide the columns (dates, phases or stages), the lanes (who or what acts), and what happens in each cell. If a gap would change the picture, ask one short question. Otherwise pick a sensible default and say what you assumed.
2. **Write the spec** to a `.json` file next to where the image will be used (for example `docs/diagrams/<name>.json`). Start from `examples/order-with-payment-retry.json` in this skill's folder and edit it. Do not start from an empty file.
3. **Render**:
   `node <skill folder>/scripts/render.mjs <spec.json> <out.png>`
   Options: `--scale 2` (default, sharp), `--bare` (no border), `--dark`.
4. **Read the PNG** with the Read tool and look at it. Fix everything under "Layout warnings", and anything that looks crowded, then render again. Two or three rounds is normal.
5. **Tell the user** where the PNG and JSON are. Say that changing the picture later means editing the JSON and rendering again.

If the script prints `Spec problems`, it names the item and the mistake. Fix them and run it again.

**First run only:** `cd <skill folder> && npm install` (installs puppeteer-core). It also needs Google Chrome; set `CHROME_PATH` if Chrome is not in the usual place. The script says so if either is missing.

## Spec format

```json
{
  "aria": "One sentence describing the diagram, used as alt text.",
  "lanes":  [ { "id": "customer", "name": "Customer", "sub": "shopper", "tint": "grey" } ],
  "phases": [ { "n": "3 Mar", "c": "checkout", "w": 1, "tone": "bad" } ],
  "items":  [ ["lane id", phaseIndex, x, row, "kind", "text", "id", "startedById"] ],
  "links":  [ { "a": "idA", "b": "idB", "style": "solid" } ],
  "legend": { "run": "background job" }
}
```

- **lanes** are the rows, top to bottom. `id` is what items refer to. `name` is at most 18 characters and `sub` (optional small caption) at most 26. `tint` is `"grey"` or `"blue"` and shades the lane, which is useful for the lane that holds the system's own state. Use 3 to 7 lanes.
- **phases** are the columns, left to right, in time order. `n` is the heading (a date or stage name), `c` a short caption, `w` the relative width (1 to 2; give busy columns more). `tone: "bad"` makes the heading red for a column where something goes wrong. Use 4 to 8 columns.
- **items** are the boxes. The array fields, in order:
  1. lane id
  2. phase index (0 is the first column)
  3. x: position inside the column, 0 to 1 (0.5 = centred)
  4. row inside the lane: 0 is the top row. Use row 1 (or 2) when boxes would collide.
  5. kind (table below)
  6. text: 2 to 4 words
  7. id (optional; needed if something points at this item or you want a mark on it)
  8. started-by id (optional; draws an arrow from that item to this one)
- **status bars** use the object form: `{ "k": "track", "lane": "app", "p": 0, "to": 3, "x0": 0.03, "x1": 0.8, "t": "in progress" }`. `p` and `to` are the first and last column, and `x0` and `x1` are where the bar starts and ends inside them. Add `"tone": "bad"` for a red status, or `"tone": "end"` for a dashed grey final status. Put status bars in row 0 of their lane, with the events that change state in row 1.
- **links** are extra arrows between two ids. `style` is `"solid"` (default) or `"trigger"` (dotted blue). A started-by id already draws an arrow, so most specs need no links.
- **legend** is optional. The legend is built from the kinds you used. Set `"legend": { "<kind>": "label" }` to rename an entry, for example `"run": "background job"`, or `"legend": false` to hide it. The arrow entries are `solid` and `trigger`.
- **marks** (optional): numbered red circles on an item, `{ "on": "id", "n": 1 }`. Add `"legend": { "mark": "see risk 1–3" }` to say what they mean.
- **colors** (optional): `{ "accent": "#0B7A75", "accentTint": "#E0F2F1", "risk": "#C0392B" }` to match a brand.
- **font** (optional): a CSS font-family string. The default is the system font.

### Kinds

| kind | looks like | use for |
|---|---|---|
| `chip` | plain box | an event, a record, an action that went fine |
| `bad` | dashed red box | a bad outcome: a rejection, an error, a timeout |
| `timer` | box with a clock | something scheduled: a deadline, a retry timer, a cron job |
| `void` | grey, struck through | a scheduled thing that was cancelled and never happened |
| `run` | blue pill with ▶ | a process or job started by an event (its started-by is a non-timer item) |
| `runT` | blue pill with a clock | a process or job started by a timer (its started-by is a `timer` item) |
| `fail` | dashed red pill with × | a process or job that failed |
| `track` | rounded bar across columns | a status: "open", "paid", "blocked" |
| `span` | dashed range box | a period of time: "maintenance window" |

Arrows: an arrow from a `timer` is solid; from anything else it is dotted blue.

You do not have to use every kind. A simple diagram of chips and status bars is fine. Only use `run`, `runT`, `timer`, `void` and `fail` when the subject has timers or background jobs.

## Layout rules (the script checks the last four)

- Give the lanes real names from the user's subject. Do not reuse the example's lanes.
- Order lanes so arrows mostly run downward: people or triggers at the top, then systems, then outside parties.
- Text on a box: 2 to 4 words, at most about 24 characters. Put detail in the text around the image.
- Aim for one or two boxes per lane per column. If three things happen in one column, use rows 0, 1 and 2, or split the column.
- Two boxes in the same lane and row need different x values (for example 0.25 and 0.75) or different rows. A box must not cross a column line.
- A status bar's label must fit inside it. A short bar needs a short label or a wider column.
- Use red only for what went wrong: `bad`, `fail`, a `bad` column, a `bad` status.
- Keep to about 45 items. A bigger flow is two diagrams.
- A started-by source should be in a lane above its target.

## Using the PNG

- **Confluence:** edit the page, drag the PNG in (or `/image`), set it to full width, and paste the `aria` sentence as alt text. The file is 2560 px wide, so it stays sharp when enlarged. Use PNG rather than SVG, because Confluence handles uploaded SVGs unreliably.
- **Docs and READMEs:** link the PNG with the `aria` sentence as alt text.
- Keep the `.json` in the repo so anyone can regenerate the picture.

## When this skill does not fit

It draws swimlanes only. For sequence diagrams, state machines, ER diagrams or architecture boxes, say so and use another tool (Mermaid, draw.io).
