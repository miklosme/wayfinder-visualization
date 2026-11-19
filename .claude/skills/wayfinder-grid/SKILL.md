---
name: wayfinder-grid
description: Show wayfinder maps as fog-of-war progress grids, START to TARGET.
argument-hint: "[owner/repo] [map number or URL ...] [--all]"
disable-model-invocation: true
---

Draw each wayfinder **map** as a grid: START bottom-left, TARGET top-right, the route a straight line between them, every ticket a square coloured by its state, and everything not yet charted under **fog**. One glance answers how far the map has come and what is takeable now.

## Steps

1. **Render.** Pass the user's arguments straight through:

   ```bash
   bun ${CLAUDE_SKILL_DIR}/render.ts $ARGUMENTS
   ```

   With no map named it draws every open map in the repo; `--all` adds the closed ones. With no repo named it uses the current checkout's GitHub repo. Done when it prints the page path followed by one summary block per map.

2. **Show the page.** Display the printed HTML file inline with the harness's HTML display; where the harness has none, open it in the user's browser. Done when the grid is in front of the user.

3. **Narrate.** One sentence per map from its summary block, naming the claimed and frontier tickets by title. The page already carries the counts, so say only what moves the user to their next ticket.

## Maps outside GitHub

`render.ts` reads maps from GitHub issues. For a map on another tracker (local markdown, Linear), read it with that tracker's own tools, write it out as a JSON array of `WayfinderMap` (typed at the top of [layout.ts](layout.ts)), and render with `--data <file>` in place of the map arguments.

## Changing the picture

- [layout.ts](layout.ts) decides the grid size and which square each ticket takes. It is pure, and the seam for a future React component.
- [render.ts](render.ts) fetches the maps and writes the page.
- [page.css](page.css) holds every colour and the fog texture's look.
