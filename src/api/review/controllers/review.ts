/**
 * review controller
 *
 * Reviews over een route. Ze komen altijd binnen met
 * review_status "pending" en verschijnen pas op de site nadat iemand ze in
 * Strapi (Content Manager > Review) op "approved" zet. listFor geeft enkel
 * goedgekeurde reviews terug.
 */

import { factories } from '@strapi/strapi';

const UID = 'api::review.review';
const CONTENT_LOCALE = process.env.STRAPI_LOCALE || 'nl';

// Bewust enkel routes: geen reviews bij logies.
const TARGETS = {
  route: { uid: 'api::route.route', titleField: 'title', label: 'route' },
} as const;

type TargetType = keyof typeof TARGETS;

const isTargetType = (value: unknown): value is TargetType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(TARGETS, value);

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PHOTOS = 5;
const MIN_TEXT_LENGTH = 10;
const MAX_TEXT_LENGTH = 2000;
const REVIEW_FOLDER_NAME = 'reviews';

const toArray = <T>(value: T | T[] | undefined | null): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const toPhoto = (file: any) => ({
  url: file?.url ?? null,
  thumbnailUrl: file?.formats?.small?.url ?? file?.formats?.thumbnail?.url ?? file?.url ?? null,
  width: file?.width ?? null,
  height: file?.height ?? null,
  alt: file?.alternativeText ?? null,
});

const toPublicReview = (review: any) => ({
  id: review.documentId,
  authorName: review.author_name || 'Routezoeker-gebruiker',
  rating: review.rating,
  text: review.text ?? '',
  visitedOn: review.visited_on ?? null,
  createdAt: review.createdAt,
  photos: toArray(review.photos).map(toPhoto).filter((photo) => photo.url),
});

const buildAuthorName = (profile: any, user: any) => {
  const firstName = String(profile?.first_name ?? '').trim();
  const lastName = String(profile?.last_name ?? '').trim();

  if (firstName) {
    return lastName ? `${firstName} ${lastName.charAt(0).toUpperCase()}.` : firstName;
  }

  const username = String(user?.username ?? '').trim();
  if (username && !username.includes('@')) return username.slice(0, 80);

  return 'Routezoeker-gebruiker';
};

const parseVisitedOn = (value: unknown) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;

  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    return undefined;
  }

  return raw;
};

export default factories.createCoreController(UID, ({ strapi }) => {
  const getReviewFolderId = async (): Promise<number | null> => {
    try {
      const existing = await strapi.db.query('plugin::upload.folder').findOne({
        where: { name: REVIEW_FOLDER_NAME, parent: null },
        select: ['id'],
      });
      if (existing?.id) return existing.id;

      const created = await strapi
        .plugin('upload')
        .service('folder')
        .create({ name: REVIEW_FOLDER_NAME, parent: null });
      return created?.id ?? null;
    } catch (error) {
      strapi.log.warn('[review] mediamap "reviews" kon niet aangemaakt worden', error);
      return null;
    }
  };

  const notifyModerators = async (review: any, targetType: TargetType, targetTitle: string) => {
    const to = process.env.REVIEW_NOTIFY_EMAIL || process.env.SMTP_REPLY_TO || 'info@routezoeker.com';
    const adminBase = (process.env.STRAPI_ADMIN_URL || process.env.PUBLIC_URL || 'https://api.routezoeker.com').replace(/\/+$/, '');
    const adminUrl = `${adminBase}/admin/content-manager/collection-types/${UID}/${review.documentId}`;
    const escape = (value: unknown) =>
      String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
    const label = TARGETS[targetType].label;

    try {
      await strapi.plugin('email').service('email').send({
        to,
        subject: `Nieuwe review voor ${label} ${targetTitle} (${review.rating}/5)`,
        html: `<p>Er is een nieuwe review binnengekomen die op goedkeuring wacht.</p>
<p><strong>${escape(label.charAt(0).toUpperCase() + label.slice(1))}:</strong> ${escape(targetTitle)}<br>
<strong>Door:</strong> ${escape(review.author_name)}<br>
<strong>Score:</strong> ${escape(review.rating)}/5<br>
<strong>Foto's:</strong> ${toArray(review.photos).length}</p>
<blockquote>${escape(review.text).replace(/\n/g, '<br>')}</blockquote>
<p><a href="${adminUrl}">Bekijk en keur goed in Strapi</a> (zet <em>review_status</em> op <em>approved</em>).</p>`,
      });
    } catch (error) {
      strapi.log.warn('[review] notificatiemail kon niet verstuurd worden', error);
    }
  };

  return {
    async listFor(ctx) {
      const targetType = ctx.params.targetType;
      const documentId = String(ctx.params.documentId ?? '').trim();
      if (!isTargetType(targetType)) return ctx.badRequest('Onbekend type.');
      if (!documentId) return ctx.badRequest('Document ontbreekt.');

      const reviews = await strapi.documents(UID).findMany({
        filters: {
          review_status: 'approved',
          [targetType]: { documentId },
        },
        fields: ['author_name', 'rating', 'text', 'visited_on', 'createdAt'],
        populate: {
          photos: { fields: ['url', 'formats', 'width', 'height', 'alternativeText'] },
        },
        sort: { createdAt: 'desc' },
        limit: 200,
      } as any);

      const count = reviews.length;
      const average = count
        ? Math.round((reviews.reduce((sum: number, review: any) => sum + Number(review.rating || 0), 0) / count) * 10) / 10
        : null;

      return {
        data: reviews.map(toPublicReview),
        meta: { count, average },
      };
    },

    async submitMe(ctx) {
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized('Meld je aan om een review te schrijven.');

      const body = (ctx.request.body ?? {}) as Record<string, unknown>;
      const targetType = body.targetType;
      const targetDocumentId = String(body.targetDocumentId ?? '').trim();
      const rating = Number(body.rating);
      const text = String(body.text ?? '').trim();
      const visitedOn = parseVisitedOn(body.visitedOn);

      if (!isTargetType(targetType)) return ctx.badRequest('Onbekend type.');
      if (!targetDocumentId) return ctx.badRequest('Document ontbreekt.');
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return ctx.badRequest('Geef een score van 1 tot 5 sterren.');
      }
      if (text.length < MIN_TEXT_LENGTH) {
        return ctx.badRequest(`Schrijf minstens ${MIN_TEXT_LENGTH} tekens.`);
      }
      if (text.length > MAX_TEXT_LENGTH) {
        return ctx.badRequest(`Je review mag maximaal ${MAX_TEXT_LENGTH} tekens lang zijn.`);
      }
      if (visitedOn === undefined) return ctx.badRequest('De datum is ongeldig.');

      const files: any[] = toArray((ctx.request as any).files?.photos);
      if (files.length > MAX_PHOTOS) {
        return ctx.badRequest(`Je kan maximaal ${MAX_PHOTOS} foto's toevoegen.`);
      }
      for (const file of files) {
        const mimeType = file.mimetype || file.type;
        if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
          return ctx.badRequest('Enkel JPG-, PNG- of WebP-foto\'s zijn toegelaten.');
        }
        if (Number(file.size) > MAX_IMAGE_BYTES) {
          return ctx.badRequest('Een foto is te groot (maximaal 10 MB per foto).');
        }
      }

      const target = TARGETS[targetType];
      const targetDoc: any = await strapi.documents(target.uid as any).findOne({
        documentId: targetDocumentId,
        locale: CONTENT_LOCALE,
        status: 'published',
        fields: [target.titleField],
      } as any);
      if (!targetDoc) return ctx.notFound(`Deze ${target.label} bestaat niet (meer).`);

      const existing = await strapi.documents(UID).findMany({
        filters: {
          user: { id: user.id },
          [targetType]: { documentId: targetDocumentId },
          review_status: { $in: ['pending', 'approved'] },
        },
        fields: ['review_status'],
        limit: 1,
      } as any);
      if (existing[0]) {
        return ctx.conflict(
          (existing[0] as any).review_status === 'pending'
            ? `Je review voor deze ${target.label} wacht nog op goedkeuring.`
            : `Je schreef al een review voor deze ${target.label}.`
        );
      }

      const profile = await strapi.documents('api::user-profile.user-profile').findFirst({
        filters: { user: { id: user.id } },
        fields: ['first_name', 'last_name'],
      } as any);
      const authorName = buildAuthorName(profile, user);
      const targetTitle = String(targetDoc[target.titleField] ?? '');

      let photoIds: number[] = [];
      if (files.length) {
        const folderId = await getReviewFolderId();
        const uploaded = await strapi
          .plugin('upload')
          .service('upload')
          .upload({
            data: {
              fileInfo: files.map((file, index) => ({
                name: file.originalFilename || file.name || `review-${index + 1}`,
                alternativeText: `Foto van ${targetTitle} door ${authorName}`,
                caption: `review:${targetType}:${targetDocumentId}:user:${user.id}`,
                ...(folderId ? { folder: folderId } : {}),
              })),
            },
            files: files.length === 1 ? files[0] : files,
          });
        photoIds = toArray(uploaded).map((file: any) => file.id).filter(Boolean);
      }

      const review = await strapi.documents(UID).create({
        data: {
          review_status: 'pending',
          [targetType]: { connect: [{ documentId: targetDocumentId, locale: CONTENT_LOCALE }] },
          user: user.id,
          author_name: authorName,
          rating,
          text,
          visited_on: visitedOn,
          photos: photoIds,
        },
        populate: ['photos'],
      } as any);

      await notifyModerators(review, targetType, targetTitle);

      ctx.status = 201;
      return { ok: true, status: 'pending' };
    },
  };
});
