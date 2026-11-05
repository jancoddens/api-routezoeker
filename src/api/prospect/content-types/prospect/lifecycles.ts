// Houdt de opvolging bij als je in de admin de status van een prospect wijzigt:
// - status "gemaild"   -> mailed_at = vandaag, follow_up_at = vandaag + 10 dagen
// - status "opgevolgd", "partner", "niet_geinteresseerd" of "niet_contacteren"
//   -> follow_up_at leeg
// Elke statuswijziging komt met datum in het veld "history".

const FOLLOW_UP_DAYS = 10;
const UID = 'api::prospect.prospect';

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDate(date);
};

export default {
  async beforeUpdate(event: any) {
    const data = event.params?.data;
    if (!data || !data.status) return;

    const existing = await strapi.db.query(UID).findOne({
      where: event.params.where,
      select: ['status', 'history'],
    });
    if (!existing || existing.status === data.status) return;

    const today = isoDate(new Date());

    if (data.status === 'gemaild') {
      data.mailed_at = today;
      if (!('follow_up_at' in data) || !data.follow_up_at) data.follow_up_at = addDays(FOLLOW_UP_DAYS);
    } else if (['opgevolgd', 'partner', 'niet_geinteresseerd', 'niet_contacteren'].includes(data.status)) {
      data.follow_up_at = null;
    }

    const line = `${today}: ${existing.status} -> ${data.status}`;
    data.history = [existing.history, line].filter(Boolean).join('\n');
  },
};
