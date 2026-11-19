#!/usr/bin/env bun
/**
 * Render wayfinder maps as a static HTML page of fog-of-war grids.
 *
 *   bun render.ts [owner/repo] [map number | #n | issue URL ...] [--all]
 *   bun render.ts --data maps.json
 *
 * Prints the page path, then one summary block per map.
 */
import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { layoutMap, STATUS_RANK, type Layout, type Ticket, type WayfinderMap } from "./layout.ts";

/* ------------------------------------------------------------------ args */

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    all: { type: "boolean", default: false },
    data: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help) {
  console.log(`Usage:
  bun render.ts [owner/repo] [map ...] [--all] [--out page.html]
  bun render.ts --data maps.json [--out page.html]

  map       issue number, #number, or issue URL of a wayfinder map
            (none: every open map in the repo)
  --repo    owner/name; defaults to the current checkout's GitHub repo
  --all     with no map named, include closed maps too
  --data    read maps from a JSON file (WayfinderMap[], see layout.ts)
            instead of GitHub
  --out     where to write the page (default: a file in the temp dir)`);
  process.exit(0);
}

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

let repo = flags.repo;
const numbers: number[] = [];
for (const arg of positionals) {
  const url = arg.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (url) { repo ??= url[1]; numbers.push(Number(url[2])); }
  else if (/^#?\d+$/.test(arg)) numbers.push(Number(arg.replace("#", "")));
  else if (/^[\w.-]+\/[\w.-]+$/.test(arg)) repo = arg;
  else fail(`Cannot read "${arg}" as a repo, a map number, or an issue URL.`);
}

/* ---------------------------------------------------------------- GitHub */

const TYPES = ["research", "prototype", "grilling", "task"];

async function gql(query: string, strings: Record<string, string>, ints: Record<string, number> = {}): Promise<any> {
  const fields = [
    ...Object.entries(strings).flatMap(([k, v]) => ["-f", `${k}=${v}`]),
    ...Object.entries(ints).flatMap(([k, v]) => ["-F", `${k}=${v}`]),
  ];
  const res = await $`gh api graphql -f query=${query} ${fields}`.quiet().nothrow();
  if (res.exitCode !== 0) fail(`gh api graphql failed:\n${res.stderr.toString().trim()}`);
  return JSON.parse(res.stdout.toString()).data;
}

/** The bullets of one `## Heading` section of a map body. */
function section(body: string, heading: string): string {
  const lines = body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const start = lines.findIndex(l => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}
const bullets = (text: string) =>
  text.split("\n").filter(l => /^\s*[-*]\s+/.test(l))
    .map(l => l.replace(/^\s*[-*]\s+/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, "").trim())
    .filter(Boolean);

const MAP_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){issue(number:$number){
    number title url state closedAt body
    subIssues(first:100,after:$after){pageInfo{hasNextPage endCursor}
      nodes{number title url state stateReason assignees{totalCount}
        labels(first:20){nodes{name}} blockedBy(first:50){nodes{number}}}}}}}`;

async function fetchMap(repo: string, number: number): Promise<WayfinderMap> {
  const [owner, name] = repo.split("/") as [string, string];
  let issue: any, nodes: any[] = [], after: string | undefined;
  do {
    const data = await gql(MAP_QUERY, { owner, name, ...(after ? { after } : {}) }, { number });
    issue = data?.repository?.issue ?? fail(`No issue #${number} in ${repo}.`);
    nodes.push(...issue.subIssues.nodes);
    after = issue.subIssues.pageInfo.hasNextPage ? issue.subIssues.pageInfo.endCursor : undefined;
  } while (after);

  // Tickets ruled out of scope are closed but are not steps on the route.
  const outOfScope = new Set(
    [...section(issue.body ?? "", "Out of scope").matchAll(/(?:#|\/issues\/)(\d+)/g)].map(m => Number(m[1])),
  );
  const tickets: Ticket[] = nodes
    .filter(t => t.stateReason !== "NOT_PLANNED" && !outOfScope.has(t.number))
    .map(t => ({
      id: t.number,
      title: t.title,
      url: t.url,
      type: t.labels.nodes.map((l: any) => l.name.replace(/^wayfinder:/, "")).find((l: string) => TYPES.includes(l)),
      done: t.state === "CLOSED",
      claimed: t.assignees.totalCount > 0,
      blockedBy: t.blockedBy.nodes.map((b: any) => b.number),
    }));

  const title = issue.title.replace(/^wayfinder:\s*/i, "");
  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    url: issue.url,
    source: `${repo} #${issue.number}`,
    closed: issue.state === "CLOSED",
    closedAt: issue.closedAt ?? undefined,
    fog: bullets(section(issue.body ?? "", "Not yet specified")),
    tickets,
  };
}

async function listMaps(repo: string, includeClosed: boolean): Promise<number[]> {
  const [owner, name] = repo.split("/") as [string, string];
  const data = await gql(
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
      issues(first:100,labels:["wayfinder:map"],orderBy:{field:CREATED_AT,direction:DESC}){nodes{number state}}}}`,
    { owner, name },
  );
  const issues: { number: number; state: string }[] = data?.repository?.issues?.nodes ?? fail(`Cannot read ${repo}.`);
  // Open maps first, newest first within each group.
  return issues.filter(i => includeClosed || i.state === "OPEN")
    .sort((a, b) => Number(a.state !== "OPEN") - Number(b.state !== "OPEN"))
    .map(i => i.number);
}

/* ------------------------------------------------------------------ HTML */

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const LETTER: Record<string, string> = { research: "R", prototype: "P", grilling: "G", task: "T" };
const WORD = { done: "done", active: "claimed", frontier: "frontier", blocked: "blocked" } as const;
const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function renderMap(map: WayfinderMap, L: Layout, index: number): string {
  const size = Math.min(240, L.n * 40);
  const gap = L.n >= 11 ? 2 : 3;
  const cell = (size - gap * (L.n - 1)) / L.n;
  const letters = cell >= 26;

  const cells = L.cells.map(c => {
    const col = c.x, row = L.n - 1 - c.y;
    const cls = ["c", c.kind as string];
    if (c.route) cls.push("route");
    let title = "", text = "", href = "";
    if (c.ticket) {
      cls.push("t");
      const t = c.ticket;
      const waiting = t.blockers.filter(b => !b.done).map(b => b.title);
      title = `${t.title}\n${[t.type, WORD[t.status]].filter(Boolean).join(" · ")}`
        + (waiting.length ? `\nwaiting on: ${waiting.join("; ")}` : "");
      if (letters && t.type) text = LETTER[t.type] ?? "";
      href = t.url ?? "";
    } else if (c.kind === "start") title = "Start";
    else if (c.kind === "target") { title = map.closed ? "Destination reached" : "Destination"; if (map.closed) cls.push("reached"); }
    else if (c.kind === "fog" && c.route) title = c.patch.length ? `Not yet specified:\n${c.patch.map(p => clip(p)).join("\n")}` : "Not yet specified";
    const style = c.kind === "fog"
      ? ` style="--fx:${-Math.round(col * (cell + gap) + index * 71)}px;--fy:${-Math.round(row * (cell + gap) + index * 43)}px"` : "";
    const attrs = `class="${cls.join(" ")}"${style}${title ? ` title="${esc(title)}"` : ""}`;
    return href ? `<a ${attrs} href="${esc(href)}">${text}</a>` : `<div ${attrs}>${text}</div>`;
  }).join("");

  const k = L.counts, total = L.tickets.length;
  const stat = (cls: string, num: number, label: string) => num ? `<span><i class="c ${cls}"></i><b>${num}</b> ${label}</span>` : "";
  const stats = `<span><i class="c done"></i><b>${k.done}</b> of <b>${total}</b> done</span>`
    + stat("active", k.active, "claimed") + stat("frontier", k.frontier, "on the frontier")
    + stat("blocked", k.blocked, "blocked") + stat("fog", k.fog, k.fog === 1 ? "fog patch" : "fog patches");

  const open = takeable(L);
  const shown = open.slice(0, 3);
  const name = (t: Ticket) => t.url ? `<a href="${esc(t.url)}">${esc(t.title)}</a>` : `<i>${esc(t.title)}</i>`;
  const next = shown.length
    ? `<ul class="wf-next">${shown.map(t => `<li><span class="c ${t.status}"></span>${name(t)}</li>`).join("")}`
      + (open.length > shown.length ? `<li class="more">and ${open.length - shown.length} more takeable now</li>` : "")
      + `</ul>`
    : "";

  const eyebrow = [map.source, map.closed ? `closed${map.closedAt ? " " + day(map.closedAt) : ""}` : "open"].filter(Boolean).join(" · ");
  const meta = [`${L.n}×${L.n}`, `${total} ${total === 1 ? "ticket" : "tickets"}`, `${L.depth} ${L.depth === 1 ? "level" : "levels"} deep`];
  const heading = map.url ? `<a href="${esc(map.url)}">${esc(map.title)}</a>` : esc(map.title);

  return `<section class="wf-map">
  <div class="wf-board" style="--size:${size}px">
    <div class="wf-corner target">TARGET</div>
    <div class="wf-grid" style="--n:${L.n};--gap:${gap}px;--fs:${Math.round(cell * 0.42)}px">${cells}</div>
    <div class="wf-corner start">START</div>
  </div>
  <div class="wf-info">
    <div class="wf-eyebrow">${esc(eyebrow)}</div>
    <div class="wf-title">${heading}</div>
    <div class="wf-stats">${stats}</div>
    ${next}
    <div class="wf-meta">${esc(meta.join(" · "))}</div>
  </div>
</section>`;
}

const takeable = (L: Layout) =>
  L.tickets.filter(t => t.status === "active" || t.status === "frontier")
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order);

// One continuous fog texture; every fog square is a window onto it.
const FOG_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='f' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.017' numOctaves='3' seed='4' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.85 0 0 0 -0.27'/></filter><rect width='100%' height='100%' filter='url(#f)'/></svg>`;

const LEGEND = `<div class="wf-legend">
  <span><i class="c done"></i><b>Done</b></span>
  <span><i class="c active"></i><b>Claimed</b> someone is on it</span>
  <span><i class="c frontier"></i><b>Frontier</b> takeable now</span>
  <span><i class="c blocked"></i><b>Blocked</b></span>
  <span><i class="c fog"></i><b>Fog</b> not yet specified</span>
  <span><i class="c clear"></i><b>Cleared</b> known, nothing to decide</span>
</div>`;

async function page(maps: WayfinderMap[], layouts: Layout[]): Promise<string> {
  const css = await Bun.file(new URL("./page.css", import.meta.url)).text();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wayfinder visualization</title>
<style>
:root { --wf-fog: url("data:image/svg+xml,${encodeURIComponent(FOG_SVG)}"); }
${css}</style>
</head>
<body>
<div class="wf-page">
${LEGEND}
${maps.map((m, i) => renderMap(m, layouts[i]!, i)).join("\n")}
</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ main */

let maps: WayfinderMap[];
let slug = "maps";
if (flags.data) {
  const parsed = await Bun.file(flags.data).json();
  maps = Array.isArray(parsed) ? parsed : [parsed];
} else {
  if (!repo) {
    const res = await $`gh repo view --json nameWithOwner --jq .nameWithOwner`.quiet().nothrow();
    repo = res.exitCode === 0 ? res.stdout.toString().trim() : fail("This checkout has no GitHub repo. Name one: owner/repo.");
  }
  const wanted = numbers.length ? numbers : await listMaps(repo!, flags.all);
  if (!wanted.length) fail(`No ${flags.all ? "" : "open "}wayfinder maps in ${repo}.${flags.all ? "" : " Pass --all to include closed ones."}`);
  maps = await Promise.all(wanted.map(n => fetchMap(repo!, n)));
  slug = repo!.replace("/", "-");
}

const layouts = maps.map(layoutMap);
const out = flags.out ?? join(tmpdir(), "wayfinder-visualization", `${slug}.html`);
await mkdir(dirname(out), { recursive: true });
await Bun.write(out, await page(maps, layouts));

console.log(out);
maps.forEach((map, i) => {
  const L = layouts[i]!, k = L.counts;
  const parts = [`${k.done} of ${L.tickets.length} done`];
  if (k.active) parts.push(`${k.active} claimed`);
  if (k.frontier) parts.push(`${k.frontier} on the frontier`);
  if (k.blocked) parts.push(`${k.blocked} blocked`);
  if (k.fog) parts.push(`${k.fog} fog ${k.fog === 1 ? "patch" : "patches"}`);
  console.log(`\n${map.title} (${map.closed ? "closed" : "open"}): ${parts.join(", ")}`);
  for (const t of takeable(L)) console.log(`  ${WORD[t.status]}: ${t.title}`);
});
