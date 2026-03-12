export default {

  /**
   * Recalculate route popularity every Monday at 02:00
   */

  "* * * * *": async ({ strapi }) => {

    const routes = await strapi.entityService.findMany(
      "api::route.route",
      {
        fields: [
          "id",
          "view_count",
          "gpx_downloads",
          "favorite_count",
          "publishedAt"
        ],
        limit: 10000
      }
    );

    for (const route of routes) {

      const views = route.view_count || 0;
      const downloads = route.gpx_downloads || 0;
      const favorites = route.favorite_count || 0;

      const base =
        views +
        downloads * 3 +
        favorites * 5 +
        1;

      const published =
        new Date(route.publishedAt || Date.now());

      const ageHours =
        (Date.now() - published.getTime()) / 3600000;

      const score =
        Math.log10(base) + ageHours / 48;

      await strapi.entityService.update(
        "api::route.route",
        route.id,
        {
          data: {
            popularity_score: score
          }
        }
      );

    }

  }

};