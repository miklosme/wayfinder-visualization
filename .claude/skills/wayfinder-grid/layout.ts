/**
 * Pure layout: a wayfinder map in, a grid of squares out. No I/O, no DOM.
 *
 * The grid is N×N. START is bottom-left (0,0), TARGET is top-right, and the
 * route between them is a Bresenham line. Tickets are laid along that line by
 * dependency depth; what does not fit on the line sits beside it.
 */

export type TicketStatus = "done" | "active" | "frontier" | "blocked";
export type CellKind = TicketStatus | "start" | "target" | "fog" | "clear";

export interface Ticket {
  id: string | number;
  title: string;
  /** research | prototype | grilling | task */
  type?: string;
  done: boolean;
  /** Assigned to someone: a session is on it. */
  claimed?: boolean;
  /** Ids of the tickets blocking this one. Ids outside the map are ignored. */
  blockedBy?: (string | number)[];
  url?: string;
}

export interface WayfinderMap {
  title: string;
  url?: string;
  /** Where the map lives, shown above the title: "owner/repo #13". */
  source?: string;
  closed?: boolean;
  /** ISO date. */
  closedAt?: string;
  /** One entry per "Not yet specified" bullet. */
  fog?: string[];
  tickets: Ticket[];
}

export interface PlacedTicket extends Ticket {
  status: TicketStatus;
  blockers: PlacedTicket[];
  dependents: PlacedTicket[];
  order: number;
}

export interface Cell {
  x: number;
  y: number;
  kind: CellKind;
  /** On the START→TARGET line. */
  route: boolean;
  ticket: PlacedTicket | null;
  /** Fog bullets this square stands for (route fog only). */
  patch: string[];
}

export interface Layout {
  n: number;
  depth: number;
  /** Row-major from the top-left, ready for a CSS grid. */
  cells: Cell[];
  tickets: PlacedTicket[];
  counts: Record<TicketStatus | "fog", number>;
}

export const STATUS_RANK: Record<TicketStatus, number> = { done: 0, active: 1, frontier: 2, blocked: 3 };

/** The classic integer line. Corner to corner on a square grid it is a pure diagonal. */
export function bresenham(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const pts: [number, number][] = [];
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

export function layoutMap(map: WayfinderMap): Layout {
  const tickets: PlacedTicket[] = map.tickets.map((t, order) => ({
    ...t, order, status: "frontier", blockers: [], dependents: [],
  }));
  const byId = new Map(tickets.map(t => [String(t.id), t]));
  for (const t of tickets) {
    t.blockers = (t.blockedBy ?? []).map(id => byId.get(String(id))).filter((b): b is PlacedTicket => !!b && b !== t);
    for (const b of t.blockers) b.dependents.push(t);
  }
  for (const t of tickets) {
    t.status = t.done ? "done"
      : t.blockers.some(b => !b.done) ? "blocked"
      : t.claimed ? "active" : "frontier";
  }

  // Depth along the route: the longest blocking chain behind a ticket.
  const levelOf = new Map<PlacedTicket, number>();
  const walking = new Set<PlacedTicket>();
  const level = (t: PlacedTicket): number => {
    const known = levelOf.get(t);
    if (known !== undefined) return known;
    if (walking.has(t)) return 0;                       // a blocking cycle: cut it here
    walking.add(t);
    const l = t.blockers.length ? 1 + Math.max(...t.blockers.map(level)) : 0;
    walking.delete(t);
    levelOf.set(t, l);
    return l;
  };
  // How much hangs on a ticket; the heaviest of each level sits on the line.
  const weightOf = new Map<PlacedTicket, number>();
  const weight = (t: PlacedTicket): number => {
    if (!weightOf.has(t)) {
      const seen = new Set<PlacedTicket>();
      const visit = (x: PlacedTicket) => { for (const d of x.dependents) if (!seen.has(d)) { seen.add(d); visit(d); } };
      visit(t);
      weightOf.set(t, seen.size);
    }
    return weightOf.get(t)!;
  };

  const levels: PlacedTicket[][] = [];
  for (const t of tickets) (levels[level(t)] ??= []).push(t);
  for (let l = 0; l < levels.length; l++) levels[l] ??= [];
  const depth = levels.length;
  const fogPatches = map.closed ? [] : (map.fog ?? []);
  const fogSlots = Math.ceil(fogPatches.length / 2);

  // N is recomputed on every draw: long enough for the dependency chain plus
  // the fog ahead, wide enough that tickets fill about a third of the grid.
  const n = Math.max(4, depth + fogSlots + 2, Math.ceil(Math.sqrt(3 * tickets.length)));
  const line = bresenham(0, 0, n - 1, n - 1);
  const spine = line.slice(1, -1);

  // Hand the line's squares to levels; spare squares go to the widest levels.
  const alloc = levels.map(lv => Math.min(1, lv.length));
  let spare = spine.length - fogSlots - alloc.reduce((a, b) => a + b, 0);
  while (spare > 0) {
    let best = -1, bestRatio = 0;
    levels.forEach((lv, l) => {
      const ratio = lv.length / alloc[l]!;
      if (alloc[l]! < lv.length && ratio > bestRatio) { best = l; bestRatio = ratio; }
    });
    if (best < 0) break;                                // line longer than the tickets: the rest stays fog
    alloc[best]!++; spare--;
  }

  const key = (x: number, y: number) => x + "," + y;
  const taken = new Map<string, PlacedTicket>();
  const reserved = new Set(line.map(([x, y]) => key(x, y)));
  const byStatus = (a: PlacedTicket, b: PlacedTicket) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order;
  // Stand-in for "semantically similar": shared blockers, shared dependents, same type.
  const affinity = (a: PlacedTicket, b: PlacedTicket) =>
    a.blockers.filter(x => b.blockers.includes(x)).length +
    a.dependents.filter(x => b.dependents.includes(x)).length +
    (a.type && a.type === b.type ? 0.5 : 0);

  const nearestFree = (ax: number, ay: number, k: number): [number, number] | null => {
    let best: [number, number] | null = null, bestCost = Infinity;
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
      if (reserved.has(key(x, y)) || taken.has(key(x, y))) continue;
      const ahead = (x + y) - (ax + ay) > 0;            // further along the route than the anchor
      const side = Math.sign(x - y);                    // which side of the line
      const cost = (x - ax) ** 2 + (y - ay) ** 2
        + (ahead ? 0.01 : 0) + (side === (k % 2 ? 1 : -1) ? 0 : 0.001) + x * 1e-6;
      if (cost < bestCost) { bestCost = cost; best = [x, y]; }
    }
    return best;
  };

  let s = 0;
  levels.forEach((lv, l) => {
    const ranked = [...lv].sort((a, b) => weight(b) - weight(a) || a.order - b.order);
    const onLine = ranked.slice(0, alloc[l]).sort(byStatus);
    const beside = ranked.slice(alloc[l]).sort(byStatus);
    const anchors = onLine.map(t => {
      const [x, y] = spine[s++]!;
      taken.set(key(x, y), t);
      return { t, x, y, load: 0 };
    });
    for (const t of beside) {
      let anchor = anchors[0]!, bestScore = -Infinity;
      for (const a of anchors) {
        const score = affinity(t, a.t) - 0.6 * a.load - 0.4 * Math.abs(STATUS_RANK[t.status] - STATUS_RANK[a.t.status]);
        if (score > bestScore) { bestScore = score; anchor = a; }
      }
      const spot = nearestFree(anchor.x, anchor.y, anchor.load++);
      if (spot) taken.set(key(spot[0], spot[1]), t);
    }
  });

  const fogLine = spine.slice(s);                       // squares of the line no ticket claimed
  const nearDone = (x: number, y: number) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (x + dx === 0 && y + dy === 0) return true;    // START lights its surroundings
      if (taken.get(key(x + dx, y + dy))?.status === "done") return true;
    }
    return false;
  };

  const cells: Cell[] = [];
  for (let y = n - 1; y >= 0; y--) for (let x = 0; x < n; x++) {
    const ticket = taken.get(key(x, y)) ?? null;
    const route = reserved.has(key(x, y));
    let kind: CellKind, patch: string[] = [];
    if (x === 0 && y === 0) kind = "start";
    else if (x === n - 1 && y === n - 1) kind = "target";
    else if (ticket) kind = ticket.status;
    else if (map.closed) kind = "clear";
    else if (route) {
      kind = "fog";
      const i = fogLine.findIndex(([fx, fy]) => fx === x && fy === y);
      patch = fogPatches.filter((_, p) => Math.floor(p * fogLine.length / fogPatches.length) === i);
    }
    else kind = nearDone(x, y) ? "clear" : "fog";
    cells.push({ x, y, kind, route, ticket, patch });
  }

  const count = (k: TicketStatus) => tickets.filter(t => t.status === k).length;
  return {
    n, depth, cells, tickets,
    counts: { done: count("done"), active: count("active"), frontier: count("frontier"), blocked: count("blocked"), fog: fogPatches.length },
  };
}
