export default {
  type: 'content-api',
  routes: [
    {
      method: 'POST',
      path: '/me/account-deletion',
      handler: 'account-deletion-request.requestDeletion',
    },
    {
      method: 'POST',
      path: '/account-deletion/confirm',
      handler: 'account-deletion-request.confirmDeletion',
      config: {
        auth: false,
      },
    },
  ],
};
