/**
 * partner controller
 *
 * Naast de standaard CRUD bevat deze controller de endpoints voor het
 * logie-dashboard (/api/me/partners/...). Een logie-uitbater meldt zich aan met
 * zijn gewone Routezoeker-account; in Strapi koppel je dat account aan de
 * partner via het veld "managers". Enkel gekoppelde gebruikers kunnen de
 * logie bekijken/bewerken, en enkel de velden in EDITABLE_TEXT_FIELDS plus de
 * afbeeldingen (cover, logo, galerij).
 */

import { factories } from '@strapi/strapi';
import { rotateInviteCode } from '../../../utils/partner-invite';

const UID = 'api::partner.partner';
const FILE_UID = 'plugin::upload.file';
const DEFAULT_LOCALE = 'nl';

const EDITABLE_TEXT_FIELDS = {
  short_description: { max: 255 },
  description: { max: 20000 },
  website_url: { max: 500 },
  booking_url: { max: 500 },
  phone: { max: 50 },
  email: { max: 255 },
} as const;

type EditableTextField = keyof typeof EDITABLE_TEXT_FIELDS;

// Horeca: openingsuren en voorzieningen die de uitbater zelf mag aanpassen.
const FACILITY_FIELDS = [
  'has_terrace',
  'has_bike_parking',
  'has_ebike_charging',
  'has_dogs_welcome',
  'has_public_toilet',
  'has_water_refill',
  'has_groups_welcome',
] as const;
const OPENING_DAYS = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];
const MAX_OPENING_ROWS = 21;
const OPENING_NOTE_MAX = 255;

// Strapi bewaart tijden als "HH:mm:ss.SSS"; het dashboard werkt met "HH:mm".
const toShortTime = (value: unknown) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ''));
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
};

const toOpeningRows = (rows: unknown) =>
  (Array.isArray(rows) ? rows : []).map((row: any) => ({
    day: row?.day ?? '',
    opens: toShortTime(row?.opens),
    closes: toShortTime(row?.closes),
  }));

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_GALLERY_IMAGES = 30;

// Bestanden die via het dashboard worden opgeladen krijgen deze caption, zodat
// we bij het opslaan kunnen nagaan dat een gebruiker enkel afbeeldingen koppelt
// die voor díe logie werden opgeladen (en niet willekeurige bestanden uit de
// mediabibliotheek).
const uploadMarker = (documentId: string) => `rz-partner-upload:${documentId}`;

const autoPublishEnabled = () => process.env.PARTNER_SELF_EDIT_AUTO_PUBLISH !== 'false';

class ValidationError extends Error {}

/**
 * Admin-modus van het logie-dashboard: gebruikers waarvan het e-mailadres in
 * PARTNER_ADMIN_EMAILS staat (komma-gescheiden, in .env) zien en beheren alle
 * logies, ook zonder als manager gekoppeld te zijn.
 */
const isPartnerAdmin = (user: any) => {
  const email = String(user?.email ?? '').trim().toLowerCase();
  if (!email || user?.blocked) return false;
  return (process.env.PARTNER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
};

const toMedia = (file: any) => {
  if (!file?.id || !file?.url) return null;

  return {
    id: file.id,
    url: file.url,
    previewUrl:
      file.formats?.small?.url || file.formats?.medium?.url || file.formats?.thumbnail?.url || file.url,
    name: file.name ?? '',
    width: file.width ?? null,
    height: file.height ?? null,
    alternativeText: file.alternativeText ?? null,
  };
};

const toDashboardPartner = (partner: any, extra: Record<string, unknown> = {}) => ({
  documentId: partner.documentId,
  locale: partner.locale,
  name: partner.name ?? '',
  slug: partner.slug ?? '',
  type: partner.type ?? null,
  universe: partner.universe ?? null,
  short_description: partner.short_description ?? '',
  description: partner.description ?? '',
  website_url: partner.website_url ?? '',
  booking_url: partner.booking_url ?? '',
  phone: partner.phone ?? '',
  email: partner.email ?? '',
  cover_image: toMedia(partner.cover_image),
  logo: toMedia(partner.logo),
  gallery: (Array.isArray(partner.gallery) ? partner.gallery : []).map(toMedia).filter(Boolean),
  opening_hours: toOpeningRows(partner.opening_hours),
  opening_hours_note: partner.opening_hours_note ?? '',
  ...Object.fromEntries(FACILITY_FIELDS.map((field) => [field, partner[field] === true])),
  package: partner.partner_subscription?.package ?? null,
  subscription_status: partner.partner_subscription?.status_subscription ?? null,
  subscription_end_date: partner.partner_subscription?.end_date ?? null,
  // Start van de allereerste abonnementsperiode (first_run), anders de huidige start.
  subscription_start_date:
    partner.partner_subscription?.first_run ?? partner.partner_subscription?.start_date ?? null,
  updatedAt: partner.updatedAt ?? null,
  ...extra,
});

const normalizeText = (field: EditableTextField, value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`Ongeldige waarde voor ${field}.`);

  const trimmed = value.replace(/\r\n/g, '\n').trim();
  if (trimmed.length > EDITABLE_TEXT_FIELDS[field].max) {
    throw new ValidationError(`${field} mag maximaal ${EDITABLE_TEXT_FIELDS[field].max} tekens bevatten.`);
  }

  if (!trimmed) return null;

  if (field === 'website_url' || field === 'booking_url') {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(withScheme);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error();
      return url.toString();
    } catch {
      throw new ValidationError(
        field === 'website_url' ? 'Het websiteadres is niet geldig.' : 'De boekingslink is niet geldig.',
      );
    }
  }

  if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new ValidationError('Het e-mailadres is niet geldig.');
  }

  if (field === 'phone' && !/^[0-9+()./\s-]+$/.test(trimmed)) {
    throw new ValidationError('Het telefoonnummer bevat ongeldige tekens.');
  }

  return trimmed;
};

const normalizeOpeningHours = (value: unknown) => {
  if (!Array.isArray(value)) throw new ValidationError('Ongeldige openingsuren.');
  if (value.length > MAX_OPENING_ROWS) throw new ValidationError('Te veel rijen in de openingsuren.');
  return value.map((row: any) => {
    const day = String(row?.day ?? '');
    const opens = toShortTime(row?.opens);
    const closes = toShortTime(row?.closes);
    if (!OPENING_DAYS.includes(day)) throw new ValidationError('Ongeldige dag in de openingsuren.');
    if (!opens || !closes) throw new ValidationError(`Vul voor ${day.toLowerCase()} een begin- en einduur in.`);
    const [oh, om] = opens.split(':').map(Number);
    const [ch, cm] = closes.split(':').map(Number);
    if (oh > 23 || om > 59 || ch > 23 || cm > 59) throw new ValidationError(`Ongeldig uur bij ${day.toLowerCase()}.`);
    return { day, opens, closes };
  });
};

const toId = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Ongeldige afbeelding.');
  return id;
};

const getRequestedLocale = (ctx: any) => {
  const locale = String(ctx.query?.locale ?? '').trim();
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(locale) ? locale : DEFAULT_LOCALE;
};

export default factories.createCoreController(UID, ({ strapi }) => {
  /**
   * Geeft de locale terug waarin de gebruiker deze partner mag beheren, of
   * null als de gebruiker geen manager is van deze partner.
   */
  const resolveManagedLocale = async (
    userId: number,
    documentId: string,
    requestedLocale: string,
    asAdmin = false,
  ) => {
    const rows = await strapi.db.query(UID).findMany({
      where: asAdmin ? { documentId } : { documentId, managers: { id: userId } },
      select: ['locale'],
    });

    if (!rows.length) return null;

    const locales = rows.map((row: any) => row.locale).filter(Boolean);
    if (locales.includes(requestedLocale)) return requestedLocale;
    if (locales.includes(DEFAULT_LOCALE)) return DEFAULT_LOCALE;
    return locales[0] ?? requestedLocale;
  };

  const loadDraft = (documentId: string, locale: string) =>
    strapi.documents(UID).findOne({
      documentId,
      locale,
      status: 'draft',
      populate: {
        cover_image: true,
        logo: true,
        gallery: true,
        opening_hours: true,
        partner_subscription: {
          fields: ['package', 'status_subscription', 'start_date', 'end_date', 'first_run'],
        },
      },
    } as any);

  const hasPublishedVersion = async (documentId: string, locale: string) => {
    const published = await strapi.documents(UID).findOne({
      documentId,
      locale,
      status: 'published',
      fields: ['id'],
    } as any);
    return Boolean(published);
  };

  const requireUser = (ctx: any) => {
    const user = ctx.state.user;
    if (!user) {
      ctx.unauthorized('Je bent niet aangemeld.');
      return null;
    }
    return user;
  };

  const requireManagedPartner = async (ctx: any) => {
    const user = requireUser(ctx);
    if (!user) return null;

    const documentId = String(ctx.params?.documentId ?? '').trim();
    const requestedLocale = getRequestedLocale(ctx);
    let locale = documentId ? await resolveManagedLocale(user.id, documentId, requestedLocale) : null;
    let asAdmin = false;

    if (documentId && !locale && isPartnerAdmin(user)) {
      locale = await resolveManagedLocale(user.id, documentId, requestedLocale, true);
      asAdmin = Boolean(locale);
    }

    if (!documentId || !locale) {
      ctx.forbidden('Je hebt geen toegang tot deze logie.');
      return null;
    }

    return { user, documentId, locale, asAdmin };
  };

  const notifyAdmin = async (partner: any, user: any, changedFields: string[], published: boolean) => {
    const to = process.env.PARTNER_EDIT_NOTIFY_EMAIL;
    if (!to || !changedFields.length) return;

    try {
      await strapi.plugin('email').service('email').send({
        to,
        subject: `Logie aangepast: ${partner.name}`,
        text: [
          `${user.email || user.username} paste de logie "${partner.name}" aan via het dashboard.`,
          `Gewijzigde velden: ${changedFields.join(', ')}`,
          published ? 'De wijzigingen staan meteen online.' : 'De wijzigingen staan als concept klaar om na te kijken en te publiceren.',
        ].join('\n\n'),
      });
    } catch (error) {
      strapi.log.warn('[partner-dashboard] notificatiemail kon niet verstuurd worden', error);
    }
  };

  const findPartnerByInviteCode = async (code: unknown) => {
    const value = typeof code === 'string' ? code.trim() : '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(value)) return null;

    const row = await strapi.db.query(UID).findOne({
      where: { invite_code: value },
      select: ['documentId', 'locale'],
    });
    if (!row) return null;

    const rows = await strapi.db.query(UID).findMany({
      where: { documentId: row.documentId },
      select: ['locale', 'name', 'type', 'publishedAt'],
    });
    const preferred =
      rows.find((r: any) => r.locale === DEFAULT_LOCALE && !r.publishedAt) ??
      rows.find((r: any) => r.locale === DEFAULT_LOCALE) ??
      rows[0];

    return {
      documentId: row.documentId as string,
      name: (preferred?.name as string) ?? '',
      type: (preferred?.type as string) ?? null,
      draftLocales: [...new Set(rows.filter((r: any) => !r.publishedAt).map((r: any) => r.locale))] as string[],
    };
  };

  return {
    async partnerInvite(ctx) {
      const partner = await findPartnerByInviteCode(ctx.params?.code);
      if (!partner) return ctx.notFound('Deze link is ongeldig of werd al gebruikt.');
      return { name: partner.name, type: partner.type };
    },

    async claimPartnerInvite(ctx) {
      const user = requireUser(ctx);
      if (!user) return;

      const body = ctx.request.body?.data ?? ctx.request.body ?? {};
      const partner = await findPartnerByInviteCode(body.code);
      if (!partner) return ctx.badRequest('Deze link is ongeldig of werd al gebruikt.');

      const alreadyManager = await strapi.db.query(UID).findOne({
        where: { documentId: partner.documentId, managers: { id: user.id } },
        select: ['id'],
      });

      if (!alreadyManager) {
        // Koppelen op de concept-versie(s); het dashboard kijkt naar alle
        // versies, dus er hoeft niets (her)gepubliceerd te worden.
        for (const locale of partner.draftLocales) {
          await strapi.documents(UID).update({
            documentId: partner.documentId,
            locale,
            data: { managers: { connect: [{ id: user.id }] } },
          } as any);
        }
      }

      // Link is eenmalig: meteen een nieuwe code.
      await rotateInviteCode(strapi, partner.documentId);

      const to = process.env.PARTNER_EDIT_NOTIFY_EMAIL;
      if (to && !alreadyManager) {
        try {
          await strapi.plugin('email').service('email').send({
            to,
            subject: `Logie gekoppeld: ${partner.name}`,
            text: `${user.email || user.username} is via de uitnodigingslink gekoppeld als beheerder van "${partner.name}".`,
          });
        } catch (error) {
          strapi.log.warn('[partner-invite] notificatiemail kon niet verstuurd worden', error);
        }
      }

      return { documentId: partner.documentId, name: partner.name };
    },

    async myPartners(ctx) {
      const user = requireUser(ctx);
      if (!user) return;

      const rows = await strapi.db.query(UID).findMany({
        where: { managers: { id: user.id } },
        select: ['documentId', 'locale'],
      });

      const requestedLocale = getRequestedLocale(ctx);
      const byDocument = new Map<string, string[]>();
      rows.forEach((row: any) => {
        byDocument.set(row.documentId, [...(byDocument.get(row.documentId) ?? []), row.locale]);
      });

      const partners = await Promise.all(
        [...byDocument.entries()].map(async ([documentId, locales]) => {
          const locale = locales.includes(requestedLocale)
            ? requestedLocale
            : locales.includes(DEFAULT_LOCALE)
              ? DEFAULT_LOCALE
              : locales[0];
          const partner = await loadDraft(documentId, locale);
          return partner ? toDashboardPartner(partner) : null;
        }),
      );

      if (isPartnerAdmin(user)) ctx.set('X-Partner-Admin', '1');

      return partners
        .filter(Boolean)
        .sort((a: any, b: any) => a.name.localeCompare(b.name, 'nl'));
    },

    /** Admin-modus: lichte lijst van alle logies (concept-versie, standaardtaal). */
    async allPartners(ctx) {
      const user = requireUser(ctx);
      if (!user) return;
      if (!isPartnerAdmin(user)) return ctx.forbidden('Geen toegang.');

      const rows: any[] = await strapi.documents(UID).findMany({
        locale: DEFAULT_LOCALE,
        status: 'draft',
        fields: ['name', 'slug', 'type', 'universe'],
        populate: {
          partner_subscription: { fields: ['package', 'status_subscription', 'end_date'] },
          address: { fields: ['postal_code'] },
          managers: { fields: ['id'] },
        },
        sort: 'name:asc',
        limit: 10000,
      } as any);

      return rows.map((row) => ({
        documentId: row.documentId,
        name: row.name ?? '',
        slug: row.slug ?? '',
        type: row.type ?? null,
        universe: row.universe ?? null,
        postal_code: row.address?.postal_code ?? null,
        package: row.partner_subscription?.package ?? null,
        subscription_status: row.partner_subscription?.status_subscription ?? null,
        subscription_end_date: row.partner_subscription?.end_date ?? null,
        managerCount: Array.isArray(row.managers) ? row.managers.length : 0,
        isManager: Array.isArray(row.managers) && row.managers.some((m: any) => m.id === user.id),
      }));
    },

    async myPartner(ctx) {
      const access = await requireManagedPartner(ctx);
      if (!access) return;

      const partner = await loadDraft(access.documentId, access.locale);
      if (!partner) return ctx.notFound('Deze logie werd niet gevonden.');

      return toDashboardPartner(partner, {
        isPublished: await hasPublishedVersion(access.documentId, access.locale),
        viewedAsAdmin: access.asAdmin,
      });
    },

    async updateMyPartner(ctx) {
      const access = await requireManagedPartner(ctx);
      if (!access) return;

      const { documentId, locale, user } = access;
      const current: any = await loadDraft(documentId, locale);
      if (!current) return ctx.notFound('Deze logie werd niet gevonden.');

      const body = ctx.request.body?.data ?? ctx.request.body ?? {};
      const data: Record<string, unknown> = {};
      const changedFields: string[] = [];

      try {
        (Object.keys(EDITABLE_TEXT_FIELDS) as EditableTextField[]).forEach((field) => {
          if (!(field in body)) return;
          const value = normalizeText(field, body[field]);
          data[field] = value;
          if ((current[field] ?? null) !== value) changedFields.push(field);
        });

        if ('opening_hours' in body) {
          const rows = normalizeOpeningHours(body.opening_hours);
          // Strapi verwacht "HH:mm:ss.SSS"; de hele lijst wordt vervangen.
          data.opening_hours = rows.map((row) => ({
            day: row.day,
            opens: `${row.opens}:00.000`,
            closes: `${row.closes}:00.000`,
          }));
          if (JSON.stringify(toOpeningRows(current.opening_hours)) !== JSON.stringify(rows)) {
            changedFields.push('opening_hours');
          }
        }

        if ('opening_hours_note' in body) {
          const note = typeof body.opening_hours_note === 'string' ? body.opening_hours_note.trim() : '';
          if (note.length > OPENING_NOTE_MAX) {
            throw new ValidationError(`De opmerking bij de openingsuren mag maximaal ${OPENING_NOTE_MAX} tekens bevatten.`);
          }
          data.opening_hours_note = note || null;
          if ((current.opening_hours_note ?? '') !== note) changedFields.push('opening_hours_note');
        }

        FACILITY_FIELDS.forEach((field) => {
          if (!(field in body)) return;
          if (typeof body[field] !== 'boolean') throw new ValidationError('Ongeldige voorziening.');
          data[field] = body[field];
          if ((current[field] === true) !== body[field]) changedFields.push(field);
        });

        const currentIds = new Set<number>(
          [current.cover_image?.id, current.logo?.id, ...(current.gallery ?? []).map((f: any) => f.id)].filter(
            Boolean,
          ),
        );
        const requestedIds: number[] = [];

        if ('cover_image' in body) {
          const id = toId(body.cover_image);
          data.cover_image = id;
          if (id) requestedIds.push(id);
          if ((current.cover_image?.id ?? null) !== id) changedFields.push('cover_image');
        }

        if ('logo' in body) {
          const id = toId(body.logo);
          data.logo = id;
          if (id) requestedIds.push(id);
          if ((current.logo?.id ?? null) !== id) changedFields.push('logo');
        }

        if ('gallery' in body) {
          if (!Array.isArray(body.gallery)) throw new ValidationError('Ongeldige galerij.');
          const ids = [...new Set(body.gallery.map(toId).filter(Boolean) as number[])];
          if (ids.length > MAX_GALLERY_IMAGES) {
            throw new ValidationError(`Je kan maximaal ${MAX_GALLERY_IMAGES} foto's in de galerij plaatsen.`);
          }
          data.gallery = ids;
          requestedIds.push(...ids);
          const currentGallery = (current.gallery ?? []).map((f: any) => f.id);
          if (JSON.stringify(currentGallery) !== JSON.stringify(ids)) changedFields.push('gallery');
        }

        const unknownIds = [...new Set(requestedIds.filter((id) => !currentIds.has(id)))];
        if (unknownIds.length) {
          const allowed = await strapi.db.query(FILE_UID).findMany({
            where: { id: { $in: unknownIds }, caption: uploadMarker(documentId) },
            select: ['id'],
          });
          if (allowed.length !== unknownIds.length) {
            throw new ValidationError('Eén of meer afbeeldingen horen niet bij deze logie.');
          }
        }
      } catch (error) {
        if (error instanceof ValidationError) return ctx.badRequest(error.message);
        throw error;
      }

      if (changedFields.length) {
        await strapi.documents(UID).update({ documentId, locale, data } as any);
      }

      // Enkel (her)publiceren als de logie al online stond: een uitbater mag
      // een logie die nog niet gepubliceerd is niet zelf live zetten.
      const wasPublished = await hasPublishedVersion(documentId, locale);
      const publish = changedFields.length > 0 && wasPublished && autoPublishEnabled();
      if (publish) {
        await strapi.documents(UID).publish({ documentId, locale } as any);
      }

      const updated = await loadDraft(documentId, locale);
      if (!access.asAdmin) await notifyAdmin(updated, user, changedFields, publish);

      return toDashboardPartner(updated, {
        isPublished: wasPublished,
        changedFields,
        published: publish,
        pendingReview: changedFields.length > 0 && !publish,
      });
    },

    async uploadMyPartnerMedia(ctx) {
      const access = await requireManagedPartner(ctx);
      if (!access) return;

      const raw = ctx.request.files?.file;
      const file: any = Array.isArray(raw) ? raw[0] : raw;
      if (!file) return ctx.badRequest('Geen bestand ontvangen.');

      const mimeType = file.mimetype || file.type;
      if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
        return ctx.badRequest('Enkel JPG-, PNG- of WebP-afbeeldingen zijn toegelaten.');
      }
      if (Number(file.size) > MAX_IMAGE_BYTES) {
        return ctx.badRequest('De afbeelding is te groot (maximaal 10 MB).');
      }

      const partner: any = await strapi.documents(UID).findOne({
        documentId: access.documentId,
        locale: access.locale,
        status: 'draft',
        fields: ['name'],
      } as any);

      const [uploaded] = await strapi
        .plugin('upload')
        .service('upload')
        .upload({
          data: {
            fileInfo: {
              name: file.originalFilename || file.name || 'afbeelding',
              caption: uploadMarker(access.documentId),
              alternativeText: partner?.name ?? null,
            },
          },
          files: file,
        });

      return toMedia(uploaded);
    },
  };
});
