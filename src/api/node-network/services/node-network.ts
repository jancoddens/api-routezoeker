/**
 * node-network service
 */

import { factories } from '@strapi/strapi';

import {
  syncOfficialNodeNetwork,
  updateImportStatus,
  type OfficialNodeNetworkSourceConfig,
} from '../../../utils/official-node-network-import';

const syncLocks = new Set<number>();

type SyncableNodeNetwork = {
  id: number;
  name?: string | null;
  source_config?: OfficialNodeNetworkSourceConfig | null;
  country?: { id: number } | null;
  province?: { id: number } | null;
  region?: { id: number } | null;
};

const toSyncableNodeNetwork = (value: unknown): SyncableNodeNetwork | null => {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'number') {
    return null;
  }

  const record = value as {
    id: number;
    name?: unknown;
    source_config?: unknown;
    country?: { id?: unknown } | null;
    province?: { id?: unknown } | null;
    region?: { id?: unknown } | null;
  };

  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : null,
    source_config:
      record.source_config && typeof record.source_config === 'object' && !Array.isArray(record.source_config)
        ? (record.source_config as OfficialNodeNetworkSourceConfig)
        : null,
    country: record.country && typeof record.country.id === 'number' ? { id: record.country.id } : null,
    province: record.province && typeof record.province.id === 'number' ? { id: record.province.id } : null,
    region: record.region && typeof record.region.id === 'number' ? { id: record.region.id } : null,
  };
};

export default factories.createCoreService('api::node-network.node-network', ({ strapi }) => ({
  async syncConfiguredOfficialDatasets(options?: { ids?: number[] }) {
    const rawNodeNetworks = await strapi.entityService.findMany('api::node-network.node-network', {
      filters: {
        sync_enabled: true,
        ...(options?.ids?.length
          ? {
              id: {
                $in: options.ids,
              },
            }
          : {}),
      },
      fields: ['id', 'name', 'source_config'],
      populate: {
        country: {
          fields: ['id'],
        },
        province: {
          fields: ['id'],
        },
        region: {
          fields: ['id'],
        },
      },
      publicationState: 'preview',
      limit: 200,
    });
    const nodeNetworks = (Array.isArray(rawNodeNetworks) ? rawNodeNetworks : [])
      .map((entry) => toSyncableNodeNetwork(entry))
      .filter((entry): entry is SyncableNodeNetwork => entry !== null);

    const results = [];

    for (const nodeNetwork of nodeNetworks) {
      results.push(await this.syncOfficialDataset(nodeNetwork.id, nodeNetwork));
    }

    return results;
  },

  async syncOfficialDataset(
    nodeNetworkId: number,
    preloadedNodeNetwork?: SyncableNodeNetwork
  ) {
    if (syncLocks.has(nodeNetworkId)) {
      return {
        skipped: true,
        reason: 'sync already in progress',
      };
    }

    syncLocks.add(nodeNetworkId);

    const nodeNetwork =
      preloadedNodeNetwork ??
      toSyncableNodeNetwork(
        await strapi.entityService.findOne('api::node-network.node-network', nodeNetworkId, {
          fields: ['id', 'name', 'source_config'],
          populate: {
            country: {
              fields: ['id'],
            },
            province: {
              fields: ['id'],
            },
            region: {
              fields: ['id'],
            },
          },
          publicationState: 'preview',
        })
      );

    if (!nodeNetwork) {
      syncLocks.delete(nodeNetworkId);
      throw new Error(`Node network ${nodeNetworkId} not found`);
    }

    try {
      const result = await syncOfficialNodeNetwork(strapi, nodeNetwork);
      await updateImportStatus(strapi, nodeNetworkId, {
        last_imported_at: new Date().toISOString(),
        last_import_status: 'success',
        last_import_message: JSON.stringify(result),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown import error';
      await updateImportStatus(strapi, nodeNetworkId, {
        last_imported_at: new Date().toISOString(),
        last_import_status: 'error',
        last_import_message: message,
      });
      strapi.log.error(`Official node-network import failed for ${nodeNetworkId}`, error);
      throw error;
    } finally {
      syncLocks.delete(nodeNetworkId);
    }
  },
}));
