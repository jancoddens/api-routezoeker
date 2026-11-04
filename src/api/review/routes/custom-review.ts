export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/reviews/for/:targetType/:documentId',
      handler: 'review.listFor',
    },
    {
      method: 'POST',
      path: '/me/reviews',
      handler: 'review.submitMe',
    },
  ],
};
