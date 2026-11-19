# wayfinder-visualization

A Claude Code skill that draws [wayfinder](https://github.com/mattpocock/skills/blob/main/skills/engineering/wayfinder/SKILL.md) maps as fog-of-war progress grids.

Each map is an N×N grid. START is the bottom-left square, TARGET the top-right, and the route between them is a straight line. Tickets sit along that line by dependency depth, with parallel tickets packed beside it.

| Square | Meaning |
| --- | --- |
| Green | Done |
| Solid blue | Claimed: someone is on it |
| Hollow blue | Frontier: takeable now |
| Orange | Blocked |
| Textured grey | Fog: not yet specified |
| Flat grey | Cleared: known, nothing to decide |

## Install

Copy the skill folder into your project (or into `~/.claude/skills` to have it everywhere):

```bash
git clone https://github.com/miklosme/wayfinder-visualization
cp -r wayfinder-visualization/.claude/skills/wayfinder-grid <your-project>/.claude/skills/
```

It needs [Bun](https://bun.com) and an authenticated [GitHub CLI](https://cli.github.com).

## Use

```
/wayfinder-grid                    every open map in the current repo
/wayfinder-grid --all              closed maps too
/wayfinder-grid owner/repo 13      one map, by number or issue URL
```

The skill fetches the maps, writes a static HTML page, shows it, and names the tickets you can pick up next.

The renderer also runs on its own:

```bash
bun .claude/skills/wayfinder-grid/render.ts owner/repo --out grid.html
```

Maps are read from GitHub issues. For a map on another tracker, pass it as JSON with `--data maps.json`; the shape is the `WayfinderMap` type in [layout.ts](.claude/skills/wayfinder-grid/layout.ts).
