export default {

  async beforeCreate(event) {
    calculatePopularity(event);
  },

  async beforeUpdate(event) {
    calculatePopularity(event);
  }

};

function calculatePopularity(event) {

  const { data } = event.params;

  const views = data.view_count || 0;
  const downloads = data.gpx_downloads || 0;
  const favorites = data.favorite_count || 0;

  const base = views + downloads * 3 + favorites * 5 + 1;

  const published = new Date(data.publishedAt || Date.now());

  const ageHours =
    (Date.now() - published.getTime()) / 3600000;

  const score =
    Math.log10(base) + ageHours / 48;

  data.popularity_score = score;

}