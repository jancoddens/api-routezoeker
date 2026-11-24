import type { Core } from '@strapi/strapi';

/**
 * Pakketten voor horecapartners. De prijzen (excl. btw, per jaar) stel je in
 * via Content Manager > Factuurinstellingen (price_horeca_basis /
 * price_horeca_plus).
 */
export const HORECA_PACKAGES = ['Horeca Basis', 'Horeca Plus'] as const;
export type HorecaPackage = (typeof HORECA_PACKAGES)[number];

const DEFAULT_PRICES: Record<HorecaPackage, number> = {
  'Horeca Basis': 49,
  'Horeca Plus': 99,
};

export const getHorecaPackagePrices = async (strapi: Core.Strapi): Promise<Record<HorecaPackage, number>> => {
  try {
    const settings: any = await strapi.documents('api::invoice-setting.invoice-setting').findFirst({
      fields: ['price_horeca_basis', 'price_horeca_plus'] as any,
    });
    const basis = Number(settings?.price_horeca_basis);
    const plus = Number(settings?.price_horeca_plus);
    return {
      'Horeca Basis': Number.isFinite(basis) && basis > 0 ? basis : DEFAULT_PRICES['Horeca Basis'],
      'Horeca Plus': Number.isFinite(plus) && plus > 0 ? plus : DEFAULT_PRICES['Horeca Plus'],
    };
  } catch {
    return { ...DEFAULT_PRICES };
  }
};
