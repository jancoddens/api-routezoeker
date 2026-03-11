import fs from 'node:fs/promises';
import path from 'node:path';

import turf from '@turf/turf';
import GPXParser, { type Point as GpxPoint, type Waypoint as GpxWaypoint } from 'gpxparser';

type UploadFile = {
  url?: string | null;
  name?: string | null;
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

type ParsedGpx = {
  title: string | null;
  description: string | null;
  distanceKm: number;
  durationMinutes: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  routeGeometry: unknown;
  elevationProfile: Array<{ distance_km: number; elevation: number | null }>;
  start: { latitude: number; longitude: number };
  end: { latitude: number; longitude: number };
  waypoints: RouteWaypoint[];
};

const MAX_ELEVATION_PROFILE_POINTS = 250;

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

const calculateDurationMinutes = (points: GpxPoint[]) => {
  const timestamps = points
    .map((point) => {
      if (!point.time) {
        return null;
      }

      const time = point.time instanceof Date ? point.time.getTime() : new Date(point.time).getTime();
      return Number.isFinite(time) ? time : null;
    })
    .filter((value): value is number => value !== null);

  if (timestamps.length < 2) {
    return null;
  }

  const durationMs = timestamps[timestamps.length - 1] - timestamps[0];

  if (durationMs <= 0) {
    return null;
  }

  return Math.round(durationMs / 60000);
};

const calculateElevationChange = (points: GpxPoint[]) => {
  let gain = 0;
  let loss = 0;
  let previousElevation: number | null = null;

  for (const point of points) {
    if (typeof point.ele !== 'number') {
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

const normalizePoints = (gpx: GPXParser) => {
  const trackPoints = (gpx.tracks ?? []).flatMap((track) => track.points ?? []);

  if (trackPoints.length > 1) {
    return trackPoints;
  }

  const routePoints = (gpx.routes ?? []).flatMap((route) => route.points ?? []);

  return routePoints;
};

const parseGpx = (xml: string): ParsedGpx | null => {
  const parser = new GPXParser();
  parser.parse(xml);

  const points = normalizePoints(parser).filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon));

  if (points.length < 2) {
    return null;
  }

  const coordinates = points.map((point) =>
    typeof point.ele === 'number'
      ? [point.lon as number, point.lat as number, point.ele]
      : [point.lon as number, point.lat as number]
  );

  const rawLine = turf.lineString(coordinates);
  const cleanedLine = turf.cleanCoords(rawLine);
  const distanceKm = round(turf.length(cleanedLine, { units: 'kilometers' }), 2);
  const durationMinutes = calculateDurationMinutes(points);
  const { elevationGain, elevationLoss } = calculateElevationChange(points);

  let cumulativeDistanceKm = 0;
  const elevationProfile = clampProfilePoints(
    points.map((point, index) => {
      if (index > 0) {
        const previous = points[index - 1];
        cumulativeDistanceKm += turf.distance(
          turf.point([previous.lon as number, previous.lat as number]),
          turf.point([point.lon as number, point.lat as number]),
          { units: 'kilometers' }
        );
      }

      return {
        distance_km: round(cumulativeDistanceKm, 2),
        elevation: typeof point.ele === 'number' ? round(point.ele, 1) : null,
      };
    })
  );

  const firstTrack = parser.tracks?.[0];
  const firstRoute = parser.routes?.[0];

  return {
    title: pickFirstNonEmpty(firstTrack?.name, firstRoute?.name, parser.metadata?.name),
    description: pickFirstNonEmpty(firstTrack?.desc, firstRoute?.desc, parser.metadata?.desc),
    distanceKm,
    durationMinutes,
    elevationGain,
    elevationLoss,
    routeGeometry: cleanedLine.geometry,
    elevationProfile,
    start: {
      latitude: points[0].lat as number,
      longitude: points[0].lon as number,
    },
    end: {
      latitude: points[points.length - 1].lat as number,
      longitude: points[points.length - 1].lon as number,
    },
    waypoints: (parser.waypoints ?? [])
      .filter(
        (waypoint): waypoint is GpxWaypoint =>
          Number.isFinite(waypoint?.lat) && Number.isFinite(waypoint?.lon)
      )
      .map((waypoint) => ({
        title: pickFirstNonEmpty(waypoint.name) ?? undefined,
        description: pickFirstNonEmpty(waypoint.desc, waypoint.cmt)
          ? toBlocks(pickFirstNonEmpty(waypoint.desc, waypoint.cmt) as string)
          : undefined,
        latitude: round(waypoint.lat as number, 6),
        longitude: round(waypoint.lon as number, 6),
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
      address: buildAddress(
        startLocation.address,
        parsed.start.latitude,
        parsed.start.longitude
      ),
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
                address: buildAddress(
                  endLocation.address,
                  primary.end.latitude,
                  primary.end.longitude
                ),
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
