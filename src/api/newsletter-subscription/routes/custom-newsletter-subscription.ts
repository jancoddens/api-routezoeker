export default {
  type: 'content-api',
  routes: [
    {
      method: 'PUT',
      path: '/me/newsletter',
      handler: 'newsletter-subscription.subscribe',
      config: {
        auth: false,
      },
    },
    {
      method: 'DELETE',
      path: '/me/newsletter',
      handler: 'newsletter-subscription.unsubscribe',
      config: {
        auth: false,
      },
    },
  ],
};
