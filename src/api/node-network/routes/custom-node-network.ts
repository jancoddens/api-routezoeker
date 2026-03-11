export default {
  routes: [
    {
      method: 'POST',
      path: '/node-networks/:id/sync',
      handler: 'node-network.sync',
      config: {
        auth: false,
      },
    },
  ],
};
