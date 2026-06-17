export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/me/favorite-routes',
      handler: 'favorite-route.me',
    },
    {
      method: 'POST',
      path: '/me/favorite-routes/:routeId',
      handler: 'favorite-route.addMe',
    },
    {
      method: 'DELETE',
      path: '/me/favorite-routes/:routeId',
      handler: 'favorite-route.removeMe',
    },
  ],
};
