import fs from 'node:fs/promises';
import path from 'node:path';

type UploadFile = {
  url?: string | null;
};

type RouteAddress = {
  latitude?: number | string | null;
  longitude?: number | string | null;
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

export const buildRouteAutofill = async (route: RouteEntity) => {
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

  const shouldImportWaypoints =
    (!Array.isArray(route.route_waypoints) || route.route_waypoints.length === 0) &&
    primary.waypoints.length > 0;

  return {
    title: asText(route.title) || primary.title || route.title,
    excerpt:
      asText(route.excerpt) || !primary.description ? route.excerpt : primary.description,
    route_geometry: primary.routeGeometry,
    route_start_locations: nextStartLocations,
    route_end_location: mergedEndLocations,
    ...(shouldImportWaypoints ? { route_waypoints: primary.waypoints } : {}),
  };
};
