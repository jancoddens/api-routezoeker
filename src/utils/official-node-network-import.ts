import type { Core } from '@strapi/strapi';

type JsonRecord = Record<string, unknown>;

type GeoJsonPoint = {
  type: 'Point';
  coordinates: [number, number];
};

type GeoJsonLineString = {
  type: 'LineString' | 'MultiLineString';
  coordinates: unknown;
};

type GeoJsonFeature = {
  type: 'Feature';
  id?: string | number;
  geometry?: GeoJsonPoint | GeoJsonLineString | null;
  properties?: JsonRecord | null;
};

type GeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

export type OfficialNodeNetworkSourceConfig = {
  provider: 'geojson-pair';
  nodesUrl: string;
  connectionsUrl: string;
  nodeIdField?: string;
  nodeNumberField?: string;
  nodeNameField?: string;
  nodeLatitudeField?: string;
  nodeLongitudeField?: string;
  connectionIdField?: string;
  connectionFromField?: string;
  connectionToField?: string;
  distanceField?: string;
  distanceUnit?: 'm' | 'km';
};

type SyncStep = 1 | 2;

type NormalizedNode = {
  externalId: string;
  number: string;
  name: string;
  latitude: number;
  longitude: number;
};

type NormalizedConnection = {
  externalId: string;
  fromRef: string;
  toRef: string;
  distanceKm: number | null;
  geometry: JsonRecord | GeoJsonLineString | null;
};

const DEFAULT_NODE_ID_FIELDS = ['id', 'ID', 'objectid', 'OBJECTID', 'node_id', 'knoop_id'];
const DEFAULT_NODE_NUMBER_FIELDS = ['number', 'nr', 'NR', 'knoopnr', 'KNOOPNR', 'volgnr'];
const DEFAULT_NODE_NAME_FIELDS = ['name', 'naam', 'Naam', 'label'];
const DEFAULT_NODE_LAT_FIELDS = ['latitude', 'lat', 'LAT', 'y', 'Y'];
const DEFAULT_NODE_LNG_FIELDS = ['longitude', 'lng', 'lon', 'LON', 'x', 'X'];
const DEFAULT_CONNECTION_ID_FIELDS = ['id', 'ID', 'objectid', 'OBJECTID', 'edge_id', 'segment_id'];
const DEFAULT_CONNECTION_FROM_FIELDS = ['from', 'from_id', 'start_id', 'startnr', 'van', 'start'];
const DEFAULT_CONNECTION_TO_FIELDS = ['to', 'to_id', 'end_id', 'eindnr', 'naar', 'end'];
const DEFAULT_DISTANCE_FIELDS = ['distance_km', 'distance', 'afstand', 'length', 'lengte'];

const getObjectValue = (record: JsonRecord | null | undefined, fieldNames: string[]) => {
  if (!record) {
    return undefined;
  }

  for (const fieldName of fieldNames) {
    const value = record[fieldName];

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return undefined;
};

const toStringValue = (value: unknown) => {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

const toNumberValue = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = Number(value.replace(',', '.').trim());
  return Number.isFinite(normalized) ? normalized : null;
};

const normalizeDistanceKm = (value: unknown, unit?: 'm' | 'km') => {
  const numericValue = toNumberValue(value);

  if (numericValue === null) {
    return null;
  }

  if (unit === 'm') {
    return numericValue / 1000;
  }

  return numericValue;
};

const isFeatureCollection = (value: unknown): value is GeoJsonFeatureCollection => {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as GeoJsonFeatureCollection).type === 'FeatureCollection' &&
      Array.isArray((value as GeoJsonFeatureCollection).features)
  );
};

const fetchGeoJson = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Dataset fetch failed with status ${response.status} for ${url}`);
  }

  const payload = (await response.json()) as unknown;

  if (!isFeatureCollection(payload)) {
    throw new Error(`Expected GeoJSON FeatureCollection from ${url}`);
  }

  return payload;
};

const normalizeNodeFeature = (
  feature: GeoJsonFeature,
  sourceConfig: OfficialNodeNetworkSourceConfig
): NormalizedNode | null => {
  const properties = feature.properties ?? {};
  const externalId =
    toStringValue(
      getObjectValue(properties, [
        ...(sourceConfig.nodeIdField ? [sourceConfig.nodeIdField] : []),
        ...DEFAULT_NODE_ID_FIELDS,
      ])
    ) ?? toStringValue(feature.id);
  const number = toStringValue(
    getObjectValue(properties, [
      ...(sourceConfig.nodeNumberField ? [sourceConfig.nodeNumberField] : []),
      ...DEFAULT_NODE_NUMBER_FIELDS,
    ])
  );
  const name =
    toStringValue(
      getObjectValue(properties, [
        ...(sourceConfig.nodeNameField ? [sourceConfig.nodeNameField] : []),
        ...DEFAULT_NODE_NAME_FIELDS,
      ])
    ) ?? number;
  const latitude =
    feature.geometry?.type === 'Point'
      ? feature.geometry.coordinates[1]
      : toNumberValue(
          getObjectValue(properties, [
            ...(sourceConfig.nodeLatitudeField ? [sourceConfig.nodeLatitudeField] : []),
            ...DEFAULT_NODE_LAT_FIELDS,
          ])
        );
  const longitude =
    feature.geometry?.type === 'Point'
      ? feature.geometry.coordinates[0]
      : toNumberValue(
          getObjectValue(properties, [
            ...(sourceConfig.nodeLongitudeField ? [sourceConfig.nodeLongitudeField] : []),
            ...DEFAULT_NODE_LNG_FIELDS,
          ])
        );

  if (!externalId || !number || latitude === null || longitude === null) {
    return null;
  }

  return {
    externalId,
    number,
    name: name ?? number,
    latitude,
    longitude,
  };
};

const normalizeConnectionFeature = (
  feature: GeoJsonFeature,
  sourceConfig: OfficialNodeNetworkSourceConfig
): NormalizedConnection | null => {
  const properties = feature.properties ?? {};
  const fromRef = toStringValue(
    getObjectValue(properties, [
      ...(sourceConfig.connectionFromField ? [sourceConfig.connectionFromField] : []),
      ...DEFAULT_CONNECTION_FROM_FIELDS,
    ])
  );
  const toRef = toStringValue(
    getObjectValue(properties, [
      ...(sourceConfig.connectionToField ? [sourceConfig.connectionToField] : []),
      ...DEFAULT_CONNECTION_TO_FIELDS,
    ])
  );
  const externalId =
    toStringValue(
      getObjectValue(properties, [
        ...(sourceConfig.connectionIdField ? [sourceConfig.connectionIdField] : []),
        ...DEFAULT_CONNECTION_ID_FIELDS,
      ])
    ) ??
    toStringValue(feature.id) ??
    (fromRef && toRef ? `${fromRef}:${toRef}` : null);

  if (!externalId || !fromRef || !toRef) {
    return null;
  }

  return {
    externalId,
    fromRef,
    toRef,
    distanceKm: normalizeDistanceKm(
      getObjectValue(properties, [
        ...(sourceConfig.distanceField ? [sourceConfig.distanceField] : []),
        ...DEFAULT_DISTANCE_FIELDS,
      ]),
      sourceConfig.distanceUnit
    ),
    geometry:
      feature.geometry && typeof feature.geometry === 'object'
        ? (feature.geometry as JsonRecord | GeoJsonLineString)
        : null,
  };
};

const publishedAt = () => new Date().toISOString();

export const updateImportStatus = async (
  strapi: Core.Strapi,
  nodeNetworkId: number,
  data: {
    last_imported_at?: string;
    last_import_status: 'idle' | 'success' | 'error';
    last_import_message?: string | null;
  }
) => {
  await strapi.entityService.update('api::node-network.node-network', nodeNetworkId, {
    data: {
      ...data,
      publishedAt: publishedAt(),
    } as never,
  });
};

export const syncOfficialNodeNetwork = async (
  strapi: Core.Strapi,
  nodeNetwork: {
    id: number;
    source_config?: OfficialNodeNetworkSourceConfig | null;
    country?: { id: number } | null;
    province?: { id: number } | null;
    region?: { id: number } | null;
  },
  options?: {
    step?: SyncStep;
  }
) => {
  const sourceConfig = nodeNetwork.source_config;
  const step = options?.step;

  if (!sourceConfig || sourceConfig.provider !== 'geojson-pair') {
    throw new Error('source_config.provider must be "geojson-pair"');
  }

  const shouldSyncNodes = step === undefined || step === 1;
  const shouldSyncConnections = step === undefined || step === 2;

  const [nodeCollection, connectionCollection] = await Promise.all([
    shouldSyncNodes || shouldSyncConnections ? fetchGeoJson(sourceConfig.nodesUrl) : null,
    shouldSyncConnections ? fetchGeoJson(sourceConfig.connectionsUrl) : null,
  ]);

  const normalizedNodes = (nodeCollection?.features ?? [])
    .map((feature) => normalizeNodeFeature(feature, sourceConfig))
    .filter((node): node is NormalizedNode => node !== null);

  const existingNodes = (await strapi.entityService.findMany('api::node.node', {
    filters: {
      node_network: {
        id: nodeNetwork.id,
      },
    } as never,
    fields: ['id', 'external_id', 'number'],
    publicationState: 'preview',
    limit: normalizedNodes.length + 500,
  })) as Array<{ id: number; external_id?: string | null; number?: string | null }>;

  const nodeIdByExternalId = new Map<string, number>();
  const nodeIdByNumber = new Map<string, number>();

  for (const existingNode of existingNodes) {
    if (existingNode.external_id) {
      nodeIdByExternalId.set(existingNode.external_id, existingNode.id);
    }

    if (existingNode.number) {
      nodeIdByNumber.set(existingNode.number, existingNode.id);
    }
  }

  let createdNodes = 0;
  let updatedNodes = 0;

  if (shouldSyncNodes) {
    for (const normalizedNode of normalizedNodes) {
      const existingNodeId = nodeIdByExternalId.get(normalizedNode.externalId);
      const data = {
        external_id: normalizedNode.externalId,
        number: normalizedNode.number,
        name: normalizedNode.name,
        latitude: normalizedNode.latitude,
        longitude: normalizedNode.longitude,
        node_network: nodeNetwork.id,
        country: nodeNetwork.country?.id ?? null,
        province: nodeNetwork.province?.id ?? null,
        publishedAt: publishedAt(),
      };

      if (existingNodeId) {
        await strapi.entityService.update('api::node.node', existingNodeId, {
          data: data as never,
        });
        updatedNodes += 1;
        nodeIdByExternalId.set(normalizedNode.externalId, existingNodeId);
        nodeIdByNumber.set(normalizedNode.number, existingNodeId);
        continue;
      }

      const createdNode = (await strapi.entityService.create('api::node.node', {
        data: data as never,
      })) as { id: number };

      createdNodes += 1;
      nodeIdByExternalId.set(normalizedNode.externalId, createdNode.id);
      nodeIdByNumber.set(normalizedNode.number, createdNode.id);
    }
  }

  const normalizedConnections = (connectionCollection?.features ?? [])
    .map((feature) => normalizeConnectionFeature(feature, sourceConfig))
    .filter((connection): connection is NormalizedConnection => connection !== null);

  const existingConnections = (await strapi.entityService.findMany('api::node-connection.node-connection', {
    filters: {
      node_network: {
        id: nodeNetwork.id,
      },
    } as never,
    fields: ['id', 'external_id'],
    publicationState: 'preview',
    limit: normalizedConnections.length + 500,
  })) as Array<{ id: number; external_id?: string | null }>;

  const connectionIdByExternalId = new Map<string, number>();

  for (const existingConnection of existingConnections) {
    if (existingConnection.external_id) {
      connectionIdByExternalId.set(existingConnection.external_id, existingConnection.id);
    }
  }

  let createdConnections = 0;
  let updatedConnections = 0;
  let skippedConnections = 0;
  const incomingConnectionExternalIds = new Set<string>();

  if (shouldSyncConnections) {
    for (const normalizedConnection of normalizedConnections) {
      incomingConnectionExternalIds.add(normalizedConnection.externalId);

      const fromNodeId =
        nodeIdByExternalId.get(normalizedConnection.fromRef) ?? nodeIdByNumber.get(normalizedConnection.fromRef);
      const toNodeId =
        nodeIdByExternalId.get(normalizedConnection.toRef) ?? nodeIdByNumber.get(normalizedConnection.toRef);

      if (!fromNodeId || !toNodeId) {
        skippedConnections += 1;
        continue;
      }

      const data = {
        external_id: normalizedConnection.externalId,
        node_network: nodeNetwork.id,
        from_node: {
          set: [fromNodeId],
        },
        to_node: {
          set: [toNodeId],
        },
        distance_km: normalizedConnection.distanceKm,
        geometry: normalizedConnection.geometry,
        publishedAt: publishedAt(),
      };
      const existingConnectionId = connectionIdByExternalId.get(normalizedConnection.externalId);

      if (existingConnectionId) {
        await strapi.entityService.update('api::node-connection.node-connection', existingConnectionId, {
          data: data as never,
        });
        updatedConnections += 1;
        continue;
      }

      await strapi.entityService.create('api::node-connection.node-connection', {
        data: data as never,
      });
      createdConnections += 1;
    }

    for (const existingConnection of existingConnections) {
      if (!existingConnection.external_id || incomingConnectionExternalIds.has(existingConnection.external_id)) {
        continue;
      }

      await strapi.entityService.delete('api::node-connection.node-connection', existingConnection.id);
    }
  }

  return {
    step: step ?? 'all',
    createdNodes,
    updatedNodes,
    createdConnections,
    updatedConnections,
    skippedConnections,
    totalNodesInSource: normalizedNodes.length,
    totalConnectionsInSource: normalizedConnections.length,
  };
};
