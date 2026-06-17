export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/me/favorite-logies',
      handler: 'favorite-logie.me',
    },
    {
      method: 'POST',
      path: '/me/favorite-logies/:partnerId',
      handler: 'favorite-logie.addMe',
    },
    {
      method: 'DELETE',
      path: '/me/favorite-logies/:partnerId',
      handler: 'favorite-logie.removeMe',
    },
  ],
};
