import { getHorecaPackagePrices, HORECA_PACKAGES, type HorecaPackage } from '../../../../utils/horeca-packages';

// Kies je in de admin een horecapakket en laat je de prijs leeg, dan vullen we
// de prijs uit Factuurinstellingen in. Een ingevulde prijs blijft altijd staan.
// Bij een wijziging zonder "package" in de data (bv. enkel de status) doen we niets.
const fillHorecaPrice = async (data: Record<string, any> | undefined) => {
  if (!data || !HORECA_PACKAGES.includes(data.package as HorecaPackage)) return;
  if (data.price !== undefined && data.price !== null && data.price !== '') return;
  const prices = await getHorecaPackagePrices(strapi);
  data.price = prices[data.package as HorecaPackage];
};

export default {
  async beforeCreate(event: any) {
    await fillHorecaPrice(event.params?.data);
  },
  async beforeUpdate(event: any) {
    await fillHorecaPrice(event.params?.data);
  },
};
