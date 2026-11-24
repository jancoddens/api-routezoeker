import { getPackagePrices, isPricedPackage } from '../../../../utils/horeca-packages';

// Kies je in de admin een pakket en laat je de prijs leeg, dan vullen we de
// prijs uit Factuurinstellingen in. Een ingevulde prijs blijft altijd staan.
// Bij een wijziging zonder "package" in de data (bv. enkel de status) doen we niets.
const fillPrice = async (data: Record<string, any> | undefined) => {
  if (!data || !isPricedPackage(data.package)) return;
  if (data.price !== undefined && data.price !== null && data.price !== '') return;
  const prices = await getPackagePrices(strapi);
  data.price = prices[data.package];
};

export default {
  async beforeCreate(event: any) {
    await fillPrice(event.params?.data);
  },
  async beforeUpdate(event: any) {
    await fillPrice(event.params?.data);
  },
};
