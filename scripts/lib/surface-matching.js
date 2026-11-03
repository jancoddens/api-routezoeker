'use strict';

/**
 * Wegdek (verhard/onverhard) van een traject bepalen door het ruimtelijk te
 * koppelen aan gelabelde lijnen (wegdeklaag van Toerisme Vlaanderen of
 * OSM-wegen met surface/highway-tags).
 *
 * Resultaat per traject: [[vanFractie, totFractie, code], ...] langs de lijn,
 * met code 1 = verhard, 0 = onverhard, -1 = onbekend. Fracties (0..1) i.p.v.
 * puntindexen, zodat het ook klopt op een vereenvoudigde lijn.
 */

const CELL_DEG = 0.002; // ~150-220 m
const MAX_MATCH_M = 20;
const STEP_M = 20; // lange stukken opdelen in stapjes van max. 20 m
const MIN_RUN_M = 40; // kortere "flikkerende" stukjes opslorpen

const toMeters = (lat) => {
  const rad = (lat * Math.PI) / 180;
  return { mLat: 111320, mLng: 111320 * Math.cos(rad) };
};

const distanceM = (a, b) => {
  const { mLat, mLng } = toMeters((a[0] + b[0]) / 2);
  return Math.hypot((a[0] - b[0]) * mLat, (a[1] - b[1]) * mLng);
};

/** lines: [{ coords: [[lat, lng], ...], code: 1|0 }] */
const buildSegmentIndex = (lines) => {
  const cells = new Map();
  let count = 0;
  for (const line of lines) {
    const coords = line.coords;
    for (let i = 1; i < coords.length; i += 1) {
      const a = coords[i - 1];
      const b = coords[i];
      const segment = { a, b, code: line.code };
      const minX = Math.floor(Math.min(a[1], b[1]) / CELL_DEG);
      const maxX = Math.floor(Math.max(a[1], b[1]) / CELL_DEG);
      const minY = Math.floor(Math.min(a[0], b[0]) / CELL_DEG);
      const maxY = Math.floor(Math.max(a[0], b[0]) / CELL_DEG);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = `${x}:${y}`;
          const list = cells.get(key);
          if (list) list.push(segment);
          else cells.set(key, [segment]);
        }
      }
      count += 1;
    }
  }
  return { cells, count };
};

/** Afstand (m) van punt p tot segment ab, plus richting van ab (genormaliseerd). */
const pointToSegment = (p, a, b) => {
  const { mLat, mLng } = toMeters(p[0]);
  const ax = (a[1] - p[1]) * mLng;
  const ay = (a[0] - p[0]) * mLat;
  const bx = (b[1] - p[1]) * mLng;
  const by = (b[0] - p[0]) * mLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const len = Math.sqrt(len2) || 1;
  return { dist: Math.hypot(ax + t * dx, ay + t * dy), ux: dx / len, uy: dy / len };
};

/** Code van de best passende lijn bij punt p met richting (ux, uy), of null. */
const matchPoint = (index, p, ux, uy) => {
  const cx = Math.floor(p[1] / CELL_DEG);
  const cy = Math.floor(p[0] / CELL_DEG);
  let best = null;
  let bestScore = Infinity;
  for (let x = cx - 1; x <= cx + 1; x += 1) {
    for (let y = cy - 1; y <= cy + 1; y += 1) {
      for (const segment of index.cells.get(`${x}:${y}`) || []) {
        const { dist, ux: sx, uy: sy } = pointToSegment(p, segment.a, segment.b);
        if (dist > MAX_MATCH_M) continue;
        // Kruisende wegen benadelen: score stijgt als de richting afwijkt.
        const alignment = Math.abs(ux * sx + uy * sy);
        const score = dist + (1 - alignment) * 15;
        if (score < bestScore) {
          bestScore = score;
          best = segment.code;
        }
      }
    }
  }
  return best;
};

/**
 * coords: [[lat, lng], ...] van het traject; indexes: segmentindexen in
 * volgorde van voorkeur (de eerste die een match geeft, wint).
 */
const classifyLine = (coords, indexes) => {
  if (!Array.isArray(coords) || coords.length < 2) return null;

  // Stapjes van max. STEP_M met hun code.
  const steps = [];
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    const length = distanceM(a, b);
    if (length <= 0) continue;
    const { mLat, mLng } = toMeters(a[0]);
    const ux = ((b[1] - a[1]) * mLng) / length;
    const uy = ((b[0] - a[0]) * mLat) / length;
    const parts = Math.max(1, Math.ceil(length / STEP_M));
    for (let k = 0; k < parts; k += 1) {
      const t = (k + 0.5) / parts;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      let code = null;
      for (const index of indexes) {
        if (!index) continue;
        code = matchPoint(index, p, ux, uy);
        if (code !== null) break;
      }
      steps.push({ length: length / parts, code: code === null ? -1 : code });
    }
  }

  const total = steps.reduce((sum, step) => sum + step.length, 0);
  if (total <= 0) return null;

  // Aaneengesloten stukken samenvoegen.
  let runs = [];
  for (const step of steps) {
    const last = runs[runs.length - 1];
    if (last && last.code === step.code) last.length += step.length;
    else runs.push({ code: step.code, length: step.length });
  }

  // Korte stukjes opslorpen in de langste buur (herhalen tot stabiel).
  let changed = true;
  while (changed && runs.length > 1) {
    changed = false;
    for (let i = 0; i < runs.length; i += 1) {
      if (runs[i].length >= MIN_RUN_M) continue;
      const prev = runs[i - 1];
      const next = runs[i + 1];
      const target = !prev ? next : !next ? prev : prev.length >= next.length ? prev : next;
      target.length += runs[i].length;
      runs.splice(i, 1);
      changed = true;
      break;
    }
    const merged = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last && last.code === run.code) last.length += run.length;
      else merged.push({ ...run });
    }
    runs = merged;
  }

  const result = [];
  let position = 0;
  for (const run of runs) {
    const from = position / total;
    position += run.length;
    result.push([Math.round(from * 1e4) / 1e4, Math.round((position / total) * 1e4) / 1e4, run.code]);
  }
  result[result.length - 1][1] = 1;
  return result;
};

// ---- OSM-tags, zelfde indeling als de routepagina's (route-surface.ts) ----

const PAVED_SURFACES = new Set([
  'paved', 'asphalt', 'chipseal', 'concrete', 'concrete:plates', 'concrete:lanes',
  'paving_stones', 'paving_stones:lanes', 'sett', 'cobblestone', 'unhewn_cobblestone',
  'bricks', 'metal', 'metal_grid', 'wood', 'rubber', 'tartan', 'acrylic',
]);
const UNPAVED_SURFACES = new Set([
  'unpaved', 'compacted', 'fine_gravel', 'gravel', 'shells', 'rock', 'pebblestone',
  'ground', 'dirt', 'earth', 'grass', 'grass_paver', 'mud', 'sand', 'woodchips',
  'clay', 'stepping_stones', 'snow', 'ice',
]);
const PAVED_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service', 'pedestrian', 'cycleway', 'footway',
  'steps', 'road',
]);

/** 1 = verhard, 0 = onverhard, null = onbekend */
const classifyOsmTags = (tags = {}) => {
  const surface = String(tags.surface || '').split(';')[0].trim().toLowerCase();
  if (PAVED_SURFACES.has(surface)) return 1;
  if (UNPAVED_SURFACES.has(surface)) return 0;
  const highway = tags.highway;
  if (highway === 'track') return tags.tracktype === 'grade1' ? 1 : 0;
  if (highway === 'path' || highway === 'bridleway') return 0;
  if (highway && PAVED_HIGHWAYS.has(highway)) return 1;
  return null;
};

module.exports = { buildSegmentIndex, classifyLine, classifyOsmTags };
