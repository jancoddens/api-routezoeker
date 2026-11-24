import type { Core } from '@strapi/strapi';

/**
 * Pakketprijzen voor partners (excl. btw, per jaar). Instelbaar via
 * Content Manager > Factuurinstellingen. Een leeg veld = de standaardprijs.
 *
 * (Bestandsnaam blijft horeca-packages om bestaande imports niet te breken;
 * het bevat nu de prijzen van alle pakketten.)
 */
export const LOGIE_PACKAGES = ['Starter', 'Pro', 'Full'] as const;
export const HORECA_PACKAGES = ['Horeca Basis', 'Horeca Plus'] as const;
export type LogiePackage = (typeof LOGIE_PACKAGES)[number];
export type HorecaPackage = (typeof HORECA_PACKAGES)[number];
export type PricedPackage = LogiePackage | HorecaPackage;

const PRICE_FIELDS: Record<PricedPackage, string> = {
  Starter: 'price_starter',
  Pro: 'price_pro',
  Full: 'price_full',
  'Horeca Basis': 'price_horeca_basis',
  'Horeca Plus': 'price_horeca_plus',
};

const DEFAULT_PRICES: Record<PricedPackage, number> = {
  Starter: 39.99,
  Pro: 99,
  Full: 199,
  'Horeca Basis': 49,
  'Horeca Plus': 99,
};

export const isPricedPackage = (value: unknown): value is PricedPackage =>
  typeof value === 'string' && value in PRICE_FIELDS;

export const getPackagePrices = async (strapi: Core.Strapi): Promise<Record<PricedPackage, number>> => {
  const prices = { ...DEFAULT_PRICES };
  try {
    const settings: any = await strapi.documents('api::invoice-setting.invoice-setting').findFirst({
      fields: Object.values(PRICE_FIELDS) as any,
    });
    (Object.keys(PRICE_FIELDS) as PricedPackage[]).forEach((pkg) => {
      const value = Number(settings?.[PRICE_FIELDS[pkg]]);
      if (settings?.[PRICE_FIELDS[pkg]] !== null && Number.isFinite(value) && value > 0) prices[pkg] = value;
    });
  } catch {
    // standaardprijzen
  }
  return prices;
};

export const getHorecaPackagePrices = async (strapi: Core.Strapi): Promise<Record<HorecaPackage, number>> => {
  const prices = await getPackagePrices(strapi);
  return { 'Horeca Basis': prices['Horeca Basis'], 'Horeca Plus': prices['Horeca Plus'] };
};
