/**
 * node-planner router
 *
 * Publieke, alleen-lezen endpoints voor de knooppuntenplanner op de website.
 */

export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/node-planner/graph',
      handler: 'node-planner.graph',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/node-planner/routes',
      handler: 'node-planner.routes',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/node-planner/route',
      handler: 'node-planner.route',
      config: {
        auth: false,
      },
    },
  ],
};
