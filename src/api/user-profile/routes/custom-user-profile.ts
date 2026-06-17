export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/me/profile',
      handler: 'user-profile.me',
    },
    {
      method: 'PUT',
      path: '/me/profile',
      handler: 'user-profile.upsertMe',
    },
  ],
};
