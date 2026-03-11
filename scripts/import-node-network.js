#!/usr/bin/env node

'use strict';

const { compileStrapi, createStrapi } = require('@strapi/strapi');

const parseNodeNetworkId = () => {
  const rawValue = process.argv[2];
  const nodeNetworkId = Number(rawValue);

  if (!Number.isInteger(nodeNetworkId) || nodeNetworkId <= 0) {
    throw new Error('Usage: npm run import:node-network -- <node-network-id>');
  }

  return nodeNetworkId;
};

const run = async () => {
  const nodeNetworkId = parseNodeNetworkId();
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);

  try {
    await strapi.load();

    const result = await strapi
      .service('api::node-network.node-network')
      .syncOfficialDataset(nodeNetworkId);

    console.log(JSON.stringify({ ok: true, nodeNetworkId, result }, null, 2));
  } finally {
    await strapi.destroy();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
