import fs from 'node:fs/promises';
import path from 'node:path';
import type { Core } from '@strapi/strapi';

type UploadFile = {
  url?: string | null;
};

type RouteAddress = {
  latitude?: number | string | null;
  longitude?: number | string | null;
  province?: { id?: number | string | null } | null;
  country?: { id?: number | string | null } | null;
  [key: string]: unknown;
};

type RouteStartLocation = {
  name?: string | null;
  description?: string | null;
  address?: RouteAddress | null;
  gpx_file?: UploadFile | null;
  distance_km?: number | string | null;
  duration_minutes?: number | null;
  elevation_gain?: number | null;
  elevation_loss?: number | null;
  route_geometry?: unknown;
  elevation_profile?: unknown;
  [key: string]: unknown;
};

type RouteEndLocation = {
  name?: string | null;
  description?: string | null;
  address?: RouteAddress | null;
  [key: string]: unknown;
};

type RouteWaypoint = {
  title?: string | null;
  description?: unknown;
  latitude?: number | string | null;
  longitude?: number | string | null;
  [key: string]: unknown;
};

type RouteEntity = {
  id: number;
  title?: string | null;
  excerpt?: string | null;
  route_geometry?: unknown;
  route_start_locations?: RouteStartLocation[] | null;
  route_end_location?: RouteEndLocation[] | null;
  route_waypoints?: RouteWaypoint[] | null;
  route_nodes?: Array<{ node?: { id?: number | null } | null; order?: number | null }> | null;
};

type GpxPoint = {
  lat: number;
  lon: number;
  ele: number | null;
  time: Date | null;
};

type ParsedGpxWaypoint = {
  name: string | null;
  desc: string | null;
  cmt: string | null;
  lat: number;
  lon: number;
};

type ParsedGpx = {
  title: string | null;
  description: string | null;
  distanceKm: number;
  durationMinutes: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  routeGeometry: {
    type: 'LineString';
    coordinates: Array<[number, number] | [number, number, number]>;
  };
  elevationProfile: Array<{ distance_km: number; elevation: number | null }>;
  start: { latitude: number; longitude: number };
  end: { latitude: number; longitude: number };
  waypoints: RouteWaypoint[];
};

const MAX_ELEVATION_PROFILE_POINTS = 250;
const EARTH_RADIUS_KM = 6371;
const NODE_MATCH_DISTANCE_METERS = 50;

const round = (value: number, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const asText = (value: unknown) => {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
};

const decodeXml = (value: string | null) => {
  if (!value) {
    return null;
  }

  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
};

const pickFirstNonEmpty = (...values: Array<unknown>) => {
  for (const value of values) {
    const text = asText(value);
    if (text) {
      return text;
    }
  }

  return null;
};

const clampProfilePoints = (points: ParsedGpx['elevationProfile']) => {
  if (points.length <= MAX_ELEVATION_PROFILE_POINTS) {
    return points;
  }

  const step = Math.ceil(points.length / MAX_ELEVATION_PROFILE_POINTS);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
};

const buildAddress = (
  address: RouteAddress | null | undefined,
  latitude: number,
  longitude: number
): RouteAddress => ({
  ...(address ?? {}),
  latitude: round(latitude, 6),
  longitude: round(longitude, 6),
});

const toBlocks = (text: string) => [
  {
    type: 'paragraph',
    children: [
      {
        type: 'text',
        text,
      },
    ],
  },
];

const getFilePath = (file: UploadFile | null | undefined) => {
  const url = file?.url;

  if (!url || !url.startsWith('/uploads/')) {
    return null;
  }

  return path.join(process.cwd(), 'public', url);
};

const readGpxFile = async (file: UploadFile | null | undefined) => {
  const filePath = getFilePath(file);

  if (!filePath) {
    return null;
  }

  return fs.readFile(filePath, 'utf8');
};

const escapeTag = (tagName: string) => tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getTagText = (xml: string, tagName: string) => {
  const match = xml.match(new RegExp(`<${escapeTag(tagName)}\\b[^>]*>([\\s\\S]*?)</${escapeTag(tagName)}>`, 'i'));
  return decodeXml(match?.[1] ?? null);
};

const getAllBlocks = (xml: string, tagName: string) => {
  const matches = xml.matchAll(
    new RegExp(`<${escapeTag(tagName)}\\b[^>]*>([\\s\\S]*?)</${escapeTag(tagName)}>`, 'gi')
  );

  return Array.from(matches, (match) => match[1]);
};

const getAttributeValue = (tag: string, attribute: string) => {
  const match = tag.match(new RegExp(`${attribute}=["']([^"']+)["']`, 'i'));
  return decodeXml(match?.[1] ?? null);
};

const parseNumber = (value: string | null) => {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseDate = (value: string | null) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parsePoints = (xml: string, pointTagName: string): GpxPoint[] => {
  const matches = xml.matchAll(
    new RegExp(`<${escapeTag(pointTagName)}\\b([^>]*)>([\\s\\S]*?)</${escapeTag(pointTagName)}>`, 'gi')
  );

  return Array.from(matches, ([, attrs, inner]) => {
    const lat = parseNumber(getAttributeValue(attrs, 'lat'));
    const lon = parseNumber(getAttributeValue(attrs, 'lon'));

    if (lat === null || lon === null) {
      return null;
    }

    return {
      lat,
      lon,
      ele: parseNumber(getTagText(inner, 'ele')),
      time: parseDate(getTagText(inner, 'time')),
    };
  }).filter((point): point is GpxPoint => point !== null);
};

const parseWaypoints = (xml: string): ParsedGpxWaypoint[] => {
  const matches = xml.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi);

  return Array.from(matches, ([, attrs, inner]) => {
    const lat = parseNumber(getAttributeValue(attrs, 'lat'));
    const lon = parseNumber(getAttributeValue(attrs, 'lon'));

    if (lat === null || lon === null) {
      return null;
    }

    return {
      name: getTagText(inner, 'name'),
      desc: getTagText(inner, 'desc'),
      cmt: getTagText(inner, 'cmt'),
      lat,
      lon,
    };
  }).filter((waypoint): waypoint is ParsedGpxWaypoint => waypoint !== null);
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

const distanceBetweenCoordinatePairsMeters = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
) =>
  distanceBetweenPointsKm(
    { lat: a.latitude, lon: a.longitude, ele: null, time: null },
    { lat: b.latitude, lon: b.longitude, ele: null, time: null }
  ) * 1000;

type CandidateNode = {
  id: number;
  latitude: number;
  longitude: number;
};

const parseRelationId = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const extractRouteAreaFilter = (route: RouteEntity) => {
  const startAddress = Array.isArray(route.route_start_locations) ? route.route_start_locations[0]?.address : null;

  return {
    provinceId: parseRelationId(startAddress?.province?.id),
    countryId: parseRelationId(startAddress?.country?.id),
  };
};

const findMatchedRouteNodes = async (
  strapi: Core.Strapi,
  route: RouteEntity,
  parsed: ParsedGpx
) => {
  const { provinceId, countryId } = extractRouteAreaFilter(route);

  if (!provinceId && !countryId) {
    return [];
  }

  const candidates = (await strapi.entityService.findMany('api::node.node', {
    filters: {
      ...(provinceId
        ? {
            province: {
              id: provinceId,
            },
          }
        : {}),
      ...(countryId
        ? {
            country: {
              id: countryId,
            },
          }
        : {}),
    },
    fields: ['id', 'latitude', 'longitude'],
    publicationState: 'preview',
    limit: 50000,
  })) as Array<{ id: number; latitude?: number | string | null; longitude?: number | string | null }>;

  const normalizedCandidates = candidates
    .map((candidate) => {
      const latitude = typeof candidate.latitude === 'number' ? candidate.latitude : Number(candidate.latitude);
      const longitude = typeof candidate.longitude === 'number' ? candidate.longitude : Number(candidate.longitude);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }

      return {
        id: candidate.id,
        latitude,
        longitude,
      };
    })
    .filter((candidate): candidate is CandidateNode => candidate !== null);

  const matchedNodes: Array<{ node: number; order: number }> = [];
  const lastSeenTrackIndexByNodeId = new Map<number, number>();

  for (let trackIndex = 0; trackIndex < parsed.routeGeometry.coordinates.length; trackIndex += 1) {
    const coordinate = parsed.routeGeometry.coordinates[trackIndex];
    const trackPoint = {
      longitude: coordinate[0],
      latitude: coordinate[1],
    };

    let nearestNode: CandidateNode | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of normalizedCandidates) {
      const distance = distanceBetweenCoordinatePairsMeters(trackPoint, candidate);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestNode = candidate;
      }
    }

    if (!nearestNode || nearestDistance > NODE_MATCH_DISTANCE_METERS) {
      continue;
    }

    const previousMatch = matchedNodes[matchedNodes.length - 1];
    const lastSeenTrackIndex = lastSeenTrackIndexByNodeId.get(nearestNode.id);

    if (previousMatch?.node === nearestNode.id) {
      continue;
    }

    if (lastSeenTrackIndex !== undefined && trackIndex - lastSeenTrackIndex < 10) {
      continue;
    }

    matchedNodes.push({
      node: nearestNode.id,
      order: matchedNodes.length + 1,
    });
    lastSeenTrackIndexByNodeId.set(nearestNode.id, trackIndex);
  }

  return matchedNodes;
};

const distanceBetweenPointsKm = (from: GpxPoint, to: GpxPoint) => {
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLon = toRadians(to.lon - from.lon);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const cleanConsecutiveDuplicates = (points: GpxPoint[]) =>
  points.filter((point, index) => {
    if (index === 0) {
      return true;
    }

    const previous = points[index - 1];
    return (
      previous.lat !== point.lat ||
      previous.lon !== point.lon ||
      previous.ele !== point.ele
    );
  });

const calculateDurationMinutes = (points: GpxPoint[]) => {
  const timestamps = points
    .map((point) => point.time?.getTime() ?? null)
    .filter((value): value is number => value !== null);

  if (timestamps.length < 2) {
    return null;
  }

  const durationMs = timestamps[timestamps.length - 1] - timestamps[0];
  return durationMs > 0 ? Math.round(durationMs / 60000) : null;
};

const calculateElevationChange = (points: GpxPoint[]) => {
  let gain = 0;
  let loss = 0;
  let previousElevation: number | null = null;

  for (const point of points) {
    if (point.ele === null) {
      continue;
    }

    if (previousElevation !== null) {
      const delta = point.ele - previousElevation;
      if (delta > 0) {
        gain += delta;
      } else if (delta < 0) {
        loss += Math.abs(delta);
      }
    }

    previousElevation = point.ele;
  }

  return {
    elevationGain: gain > 0 ? Math.round(gain) : null,
    elevationLoss: loss > 0 ? Math.round(loss) : null,
  };
};

const parseGpx = (xml: string): ParsedGpx | null => {
  const metadataBlock = getAllBlocks(xml, 'metadata')[0] ?? '';
  const trackBlocks = getAllBlocks(xml, 'trk');
  const routeBlocks = getAllBlocks(xml, 'rte');
  const trackPoints = cleanConsecutiveDuplicates(
    trackBlocks.flatMap((trackBlock) => getAllBlocks(trackBlock, 'trkseg').flatMap((segment) => parsePoints(segment, 'trkpt')))
  );
  const routePoints = cleanConsecutiveDuplicates(routeBlocks.flatMap((routeBlock) => parsePoints(routeBlock, 'rtept')));
  const points = trackPoints.length > 1 ? trackPoints : routePoints;

  if (points.length < 2) {
    return null;
  }

  let distanceKm = 0;
  const elevationProfile = clampProfilePoints(
    points.map((point, index) => {
      if (index > 0) {
        distanceKm += distanceBetweenPointsKm(points[index - 1], point);
      }

      return {
        distance_km: round(distanceKm, 2),
        elevation: point.ele === null ? null : round(point.ele, 1),
      };
    })
  );

  const { elevationGain, elevationLoss } = calculateElevationChange(points);
  const firstTrack = trackBlocks[0] ?? '';
  const firstRoute = routeBlocks[0] ?? '';
  const waypoints = parseWaypoints(xml);

  return {
    title: pickFirstNonEmpty(
      getTagText(firstTrack, 'name'),
      getTagText(firstRoute, 'name'),
      getTagText(metadataBlock, 'name')
    ),
    description: pickFirstNonEmpty(
      getTagText(firstTrack, 'desc'),
      getTagText(firstRoute, 'desc'),
      getTagText(metadataBlock, 'desc')
    ),
    distanceKm: round(distanceKm, 2),
    durationMinutes: calculateDurationMinutes(points),
    elevationGain,
    elevationLoss,
    routeGeometry: {
      type: 'LineString',
      coordinates: points.map((point) =>
        point.ele === null
          ? [round(point.lon, 6), round(point.lat, 6)]
          : [round(point.lon, 6), round(point.lat, 6), round(point.ele, 1)]
      ),
    },
    elevationProfile,
    start: {
      latitude: points[0].lat,
      longitude: points[0].lon,
    },
    end: {
      latitude: points[points.length - 1].lat,
      longitude: points[points.length - 1].lon,
    },
    waypoints: waypoints.map((waypoint) => ({
      title: waypoint.name ?? undefined,
      description: pickFirstNonEmpty(waypoint.desc, waypoint.cmt)
        ? toBlocks(pickFirstNonEmpty(waypoint.desc, waypoint.cmt) as string)
        : undefined,
      latitude: round(waypoint.lat, 6),
      longitude: round(waypoint.lon, 6),
    })),
  };
};

export const buildRouteAutofill = async (route: RouteEntity, strapi: Core.Strapi) => {
  const startLocations = Array.isArray(route.route_start_locations)
    ? route.route_start_locations
    : [];

  if (startLocations.length === 0) {
    return null;
  }

  const nextStartLocations: RouteStartLocation[] = [];
  const parsedEntries: ParsedGpx[] = [];

  for (const startLocation of startLocations) {
    const gpxXml = await readGpxFile(startLocation.gpx_file);

    if (!gpxXml) {
      nextStartLocations.push(startLocation);
      continue;
    }

    const parsed = parseGpx(gpxXml);

    if (!parsed) {
      nextStartLocations.push(startLocation);
      continue;
    }

    parsedEntries.push(parsed);
    nextStartLocations.push({
      ...startLocation,
      name: asText(startLocation.name) || parsed.title || startLocation.name,
      description:
        asText(startLocation.description) || !parsed.description
          ? startLocation.description
          : parsed.description,
      address: buildAddress(startLocation.address, parsed.start.latitude, parsed.start.longitude),
      distance_km: parsed.distanceKm,
      duration_minutes: parsed.durationMinutes,
      elevation_gain: parsed.elevationGain,
      elevation_loss: parsed.elevationLoss,
      route_geometry: parsed.routeGeometry,
      elevation_profile: parsed.elevationProfile,
    });
  }

  if (parsedEntries.length === 0) {
    return null;
  }

  const primary = parsedEntries[0];
  const nextEndLocations = Array.isArray(route.route_end_location)
    ? route.route_end_location
    : [];

  const mergedEndLocations =
    nextEndLocations.length > 0
      ? nextEndLocations.map((endLocation, index) =>
          index === 0
            ? {
                ...endLocation,
                name: asText(endLocation.name) || primary.title || endLocation.name,
                description:
                  asText(endLocation.description) || !primary.description
                    ? endLocation.description
                    : primary.description,
                address: buildAddress(endLocation.address, primary.end.latitude, primary.end.longitude),
              }
            : endLocation
        )
      : [
          {
            name: primary.title ?? undefined,
            description: primary.description ?? undefined,
            address: buildAddress(null, primary.end.latitude, primary.end.longitude),
          },
        ];

  const shouldImportRouteNodes =
    !Array.isArray(route.route_nodes) || route.route_nodes.length === 0;
  const matchedRouteNodes = shouldImportRouteNodes ? await findMatchedRouteNodes(strapi, route, primary) : [];

  return {
    title: asText(route.title) || primary.title || route.title,
    excerpt:
      asText(route.excerpt) || !primary.description ? route.excerpt : primary.description,
    route_geometry: primary.routeGeometry,
    route_start_locations: nextStartLocations,
    route_end_location: mergedEndLocations,
    ...(matchedRouteNodes.length > 0 ? { route_nodes: matchedRouteNodes } : {}),
  };
};
