/**
 * Knooppuntenplanner: graaf van knooppunten + verbindingen in het geheugen.
 *
 * Bevat enkel pure functies (geen Strapi), zodat dit los te testen is:
 *  - buildPlannerGraph: ruwe knooppunten/verbindingen -> graaf met
 *    vereenvoudigde lijnen, afstanden en een ruimtelijk rooster
 *  - edgesInBbox: verbindingen + knooppunten binnen een kaartuitsnede
 *  - shortestPath: kortste pad (A*) tussen twee knooppunten
 */

export type PlannerMode = 'wandelen' | 'fietsen';

export const PLANNER_MODES: PlannerMode[] = ['wandelen', 'fietsen'];

export type RawPlannerNode = {
  id: number;
  number: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
};

export type RawPlannerConnection = {
  id: number;
  from: number | null;
  to: number | null;
  distanceKm: number | string | null;
  geometry: unknown;
  mode: PlannerMode;
};

export type PlannerNode = {
  id: number;
  n: string;
  lat: number;
  lng: number;
  /** bitmask van modes waarin dit knooppunt verbindingen heeft */
  modes: number;
};

export type PlannerEdge = {
  id: number;
  a: number;
  b: number;
  km: number;
  mode: PlannerMode;
  /** platte lijst [lat, lng, lat, lng, ...], georiënteerd van a naar b */
  coords: number[];
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

export type PlannerGraph = {
  nodes: Map<number, PlannerNode>;
  edges: PlannerEdge[];
  /** knooppunt-id -> indexen in edges */
  adjacency: Map<number, number[]>;
  /** roostercel -> indexen in edges */
  grid: Map<string, number[]>;
  builtAt: number;
};

export type Bbox = { west: number; south: number; east: number; north: number };

const GRID_CELL_DEG = 0.05;
const SIMPLIFY_TOLERANCE_DEG = 0.00003; // ~3 m
const COORD_DECIMALS = 1e5;

export const modeBit = (mode: PlannerMode) => (mode === 'fietsen' ? 2 : 1);

export const modeFromThemeSlug = (slug: unknown): PlannerMode =>
  typeof slug === 'string' && slug.toLowerCase().includes('fiets') ? 'fietsen' : 'wandelen';

export const parsePlannerMode = (value: unknown): PlannerMode =>
  value === 'fietsen' ? 'fietsen' : 'wandelen';

const toNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value: number) => Math.round(value * COORD_DECIMALS) / COORD_DECIMALS;

export const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const polylineKm = (coords: number[]) => {
  let total = 0;
  for (let i = 2; i < coords.length; i += 2) {
    total += haversineKm(coords[i - 2], coords[i - 1], coords[i], coords[i + 1]);
  }
  return total;
};

/** GeoJSON (LineString / MultiLineString / Feature) -> platte [lat, lng, ...] */
export const geometryToLatLngs = (geometry: unknown): number[] => {
  if (!geometry || typeof geometry !== 'object') {
    return [];
  }

  const record = geometry as { type?: unknown; coordinates?: unknown; geometry?: unknown };

  if (record.type === 'Feature') {
    return geometryToLatLngs(record.geometry);
  }

  const pushPoints = (points: unknown, out: number[]) => {
    if (!Array.isArray(points)) return;
    for (const point of points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const lng = toNumber(point[0]);
      const lat = toNumber(point[1]);
      if (lat === null || lng === null) continue;
      out.push(lat, lng);
    }
  };

  const out: number[] = [];

  if (record.type === 'LineString') {
    pushPoints(record.coordinates, out);
  } else if (record.type === 'MultiLineString' && Array.isArray(record.coordinates)) {
    // Stukken aan elkaar hangen; draai een stuk om als dat beter aansluit.
    for (const line of record.coordinates) {
      const part: number[] = [];
      pushPoints(line, part);
      if (part.length < 2) continue;
      if (out.length >= 2) {
        const lastLat = out[out.length - 2];
        const lastLng = out[out.length - 1];
        const toStart = haversineKm(lastLat, lastLng, part[0], part[1]);
        const toEnd = haversineKm(lastLat, lastLng, part[part.length - 2], part[part.length - 1]);
        if (toEnd < toStart) {
          out.push(...reversePairs(part));
          continue;
        }
      }
      out.push(...part);
    }
  }

  return out;
};

const reversePairs = (coords: number[]) => {
  const out: number[] = new Array(coords.length);
  for (let i = 0, j = coords.length - 2; j >= 0; i += 2, j -= 2) {
    out[i] = coords[j];
    out[i + 1] = coords[j + 1];
  }
  return out;
};

/** Douglas-Peucker op een platte [lat, lng, ...] lijst (in graden, volstaat lokaal). */
export const simplifyLatLngs = (coords: number[], tolerance = SIMPLIFY_TOLERANCE_DEG): number[] => {
  const count = coords.length / 2;
  if (count <= 2) return coords.slice();

  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: Array<[number, number]> = [[0, count - 1]];
  const tolSq = tolerance * tolerance;

  while (stack.length) {
    const [first, last] = stack.pop()!;
    const ax = coords[first * 2 + 1];
    const ay = coords[first * 2];
    const bx = coords[last * 2 + 1];
    const by = coords[last * 2];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let maxDist = -1;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const px = coords[i * 2 + 1];
      const py = coords[i * 2];
      let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const dist = ex * ex + ey * ey;
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }

    if (index !== -1 && maxDist > tolSq) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (keep[i]) out.push(round(coords[i * 2]), round(coords[i * 2 + 1]));
  }
  return out;
};

const cellKey = (x: number, y: number) => `${x}:${y}`;
const cellX = (lng: number) => Math.floor(lng / GRID_CELL_DEG);
const cellY = (lat: number) => Math.floor(lat / GRID_CELL_DEG);

export const buildPlannerGraph = (
  rawNodes: RawPlannerNode[],
  rawConnections: RawPlannerConnection[]
): PlannerGraph => {
  const allNodes = new Map<number, PlannerNode>();

  for (const raw of rawNodes) {
    const lat = toNumber(raw.latitude);
    const lng = toNumber(raw.longitude);
    if (lat === null || lng === null || (lat === 0 && lng === 0)) continue;
    allNodes.set(raw.id, {
      id: raw.id,
      n: String(raw.number ?? '').trim() || '?',
      lat,
      lng,
      modes: 0,
    });
  }

  const edges: PlannerEdge[] = [];
  const adjacency = new Map<number, number[]>();
  const grid = new Map<string, number[]>();
  const seen = new Set<string>();

  for (const raw of rawConnections) {
    if (raw.from === null || raw.to === null || raw.from === raw.to) continue;
    const a = allNodes.get(raw.from);
    const b = allNodes.get(raw.to);
    if (!a || !b) continue;

    // Dezelfde verbinding kan dubbel voorkomen (bv. heen en terug); één volstaat.
    const key = `${raw.mode}:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;

    let coords = geometryToLatLngs(raw.geometry);

    if (coords.length >= 4) {
      // Lijn oriënteren van a naar b.
      const startToA = haversineKm(coords[0], coords[1], a.lat, a.lng);
      const startToB = haversineKm(coords[0], coords[1], b.lat, b.lng);
      if (startToB < startToA) coords = reversePairs(coords);
    } else {
      coords = [a.lat, a.lng, b.lat, b.lng];
    }

    const lineKm = polylineKm(coords);
    const sourceKm = toNumber(raw.distanceKm);
    const km = sourceKm !== null && sourceKm > 0 ? sourceKm : lineKm;

    // Langere parallelle verbinding tussen dezelfde knooppunten negeren we niet:
    // een andere geometrie kan een echt alternatief pad zijn. Exacte dubbels wel.
    const dupKey = `${key}:${Math.round(km * 100)}`;
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);

    const simplified = simplifyLatLngs(coords);

    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;
    for (let i = 0; i < simplified.length; i += 2) {
      minLat = Math.min(minLat, simplified[i]);
      maxLat = Math.max(maxLat, simplified[i]);
      minLng = Math.min(minLng, simplified[i + 1]);
      maxLng = Math.max(maxLng, simplified[i + 1]);
    }

    const index = edges.length;
    edges.push({
      id: raw.id,
      a: a.id,
      b: b.id,
      km: Math.round(km * 1000) / 1000,
      mode: raw.mode,
      coords: simplified,
      minLat,
      minLng,
      maxLat,
      maxLng,
    });

    const bit = modeBit(raw.mode);
    a.modes |= bit;
    b.modes |= bit;

    for (const nodeId of [a.id, b.id]) {
      const list = adjacency.get(nodeId);
      if (list) list.push(index);
      else adjacency.set(nodeId, [index]);
    }

    for (let x = cellX(minLng); x <= cellX(maxLng); x++) {
      for (let y = cellY(minLat); y <= cellY(maxLat); y++) {
        const k = cellKey(x, y);
        const list = grid.get(k);
        if (list) list.push(index);
        else grid.set(k, [index]);
      }
    }
  }

  // Enkel knooppunten met minstens één verbinding houden.
  const nodes = new Map<number, PlannerNode>();
  for (const node of allNodes.values()) {
    if (node.modes) nodes.set(node.id, node);
  }

  return { nodes, edges, adjacency, grid, builtAt: Date.now() };
};

export const edgesInBbox = (
  graph: PlannerGraph,
  bbox: Bbox,
  mode: PlannerMode,
  maxEdges = 8000
): { nodes: PlannerNode[]; edges: PlannerEdge[]; truncated: boolean } => {
  const found = new Set<number>();
  let truncated = false;

  outer: for (let x = cellX(bbox.west); x <= cellX(bbox.east); x++) {
    for (let y = cellY(bbox.south); y <= cellY(bbox.north); y++) {
      const list = graph.grid.get(cellKey(x, y));
      if (!list) continue;
      for (const index of list) {
        if (found.has(index)) continue;
        const edge = graph.edges[index];
        if (edge.mode !== mode) continue;
        if (
          edge.maxLat < bbox.south ||
          edge.minLat > bbox.north ||
          edge.maxLng < bbox.west ||
          edge.minLng > bbox.east
        ) {
          continue;
        }
        found.add(index);
        if (found.size >= maxEdges) {
          truncated = true;
          break outer;
        }
      }
    }
  }

  const edges = Array.from(found, (index) => graph.edges[index]);
  const nodeIds = new Set<number>();
  for (const edge of edges) {
    nodeIds.add(edge.a);
    nodeIds.add(edge.b);
  }
  const nodes = Array.from(nodeIds, (id) => graph.nodes.get(id)!).filter(Boolean);

  return { nodes, edges, truncated };
};

/** Kleine binaire min-heap op prioriteit. */
class MinHeap {
  private items: Array<[number, number]> = [];

  get size() {
    return this.items.length;
  }

  push(priority: number, value: number) {
    const items = this.items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): [number, number] | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && items[l][0] < items[smallest][0]) smallest = l;
        if (r < items.length && items[r][0] < items[smallest][0]) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

export type PlannerPath = {
  km: number;
  /** knooppunt-ids in volgorde, inclusief start en einde */
  nodeIds: number[];
  /** per stap de verbinding, met lijn georiënteerd in looprichting */
  steps: Array<{ edge: PlannerEdge; reversed: boolean }>;
};

export const shortestPath = (
  graph: PlannerGraph,
  fromId: number,
  toId: number,
  mode: PlannerMode,
  maxExpansions = 400000
): PlannerPath | null => {
  const from = graph.nodes.get(fromId);
  const to = graph.nodes.get(toId);
  if (!from || !to) return null;

  if (fromId === toId) {
    return { km: 0, nodeIds: [fromId], steps: [] };
  }

  // Afstanden uit de bron kunnen iets korter zijn dan hemelsbreed; de factor
  // houdt de heuristiek veilig (onderschat altijd).
  const heuristic = (node: PlannerNode) => haversineKm(node.lat, node.lng, to.lat, to.lng) * 0.8;

  const dist = new Map<number, number>([[fromId, 0]]);
  const via = new Map<number, number>(); // node -> edge index
  const closed = new Set<number>();
  const heap = new MinHeap();
  heap.push(heuristic(from), fromId);
  let expansions = 0;

  while (heap.size) {
    const [, current] = heap.pop()!;
    if (closed.has(current)) continue;
    if (current === toId) break;
    closed.add(current);
    if (++expansions > maxExpansions) return null;

    const currentDist = dist.get(current)!;
    for (const index of graph.adjacency.get(current) ?? []) {
      const edge = graph.edges[index];
      if (edge.mode !== mode) continue;
      const next = edge.a === current ? edge.b : edge.a;
      if (closed.has(next)) continue;
      const candidate = currentDist + edge.km;
      if (candidate < (dist.get(next) ?? Infinity)) {
        dist.set(next, candidate);
        via.set(next, index);
        heap.push(candidate + heuristic(graph.nodes.get(next)!), next);
      }
    }
  }

  if (!dist.has(toId)) return null;

  const nodeIds = [toId];
  const steps: PlannerPath['steps'] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const edge = graph.edges[via.get(cursor)!];
    const previous = edge.a === cursor ? edge.b : edge.a;
    steps.push({ edge, reversed: edge.a !== previous });
    nodeIds.push(previous);
    cursor = previous;
  }
  nodeIds.reverse();
  steps.reverse();

  return { km: Math.round(dist.get(toId)! * 1000) / 1000, nodeIds, steps };
};

/** Lijn van een stap in looprichting. */
export const stepCoords = (step: { edge: PlannerEdge; reversed: boolean }) =>
  step.reversed ? reversePairs(step.edge.coords) : step.edge.coords;
