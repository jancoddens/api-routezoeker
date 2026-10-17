import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

// Bij de import van de bestaande accounts (zie scripts/import-legacy-users.js)
// kregen gebruikers met een oud, ongesalt MD5-wachtwoord (uit de vorige PHP-site)
// géén nieuwe/onbruikbare wachtwoordhash: hun `password`-veld werd letterlijk
// `md5:<hun-oude-md5-hash>` i.p.v. een bcrypt-hash.
//
// Zo blijft hun bestaande wachtwoord meteen werken zonder reset: bij hun
// eerstvolgende login (hieronder) checken we of het ingevoerde wachtwoord
// matcht met die oude MD5-hash. Zo ja, dan upgraden we het wachtwoord meteen
// naar een normale bcrypt-hash en verloopt de rest van de login zoals altijd.
// Gebruikers met een reeds-bcrypt wachtwoord (het gros van de bestaande
// accounts -- zie het importrapport) hebben dit helemaal niet nodig: hun
// hash werkt al meteen met Strapi's eigen bcrypt-check.
//
// Waarom hier ingrijpen i.p.v. de hele login-controller herschrijven?
// We laten Strapi's eigen `auth.callback` het echte werk doen (blocked-check,
// confirmed-check, JWT, rate limiting, ...) -- we voegen enkel, vlak ervoor,
// een stille "upgrade indien nodig"-stap toe die voor 100% van de bcrypt-
// gebruikers een complete no-op is.

const USER_MODEL_UID = 'plugin::users-permissions.user';
const LEGACY_MD5_PREFIX = 'md5:';
const BCRYPT_ROUNDS = 10;

function isLikelyHex(value: string): boolean {
  return /^[a-f0-9]+$/i.test(value);
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || !isLikelyHex(a) || !isLikelyHex(b)) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

async function upgradeLegacyMd5PasswordIfNeeded(identifier: string, password: string): Promise<void> {
  const user = await strapi.db.query(USER_MODEL_UID).findOne({
    where: {
      provider: 'local',
      $or: [{ email: identifier.toLowerCase() }, { username: identifier }],
    },
    select: ['id', 'password'],
  });

  if (!user || typeof user.password !== 'string' || !user.password.startsWith(LEGACY_MD5_PREFIX)) {
    // Geen match, of dit is al een normale (bcrypt) gebruiker -- niets te doen,
    // de originele callback handelt de rest normaal af.
    return;
  }

  const legacyMd5 = user.password.slice(LEGACY_MD5_PREFIX.length);
  const candidateMd5 = crypto.createHash('md5').update(password, 'utf8').digest('hex');

  if (!timingSafeHexEqual(candidateMd5, legacyMd5)) {
    // Fout wachtwoord: laat de originele callback dit gewoon (opnieuw) laten
    // falen op de normale manier, met dezelfde generieke foutmelding.
    return;
  }

  const upgradedHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await strapi.db.query(USER_MODEL_UID).update({
    where: { id: user.id },
    data: { password: upgradedHash },
  });

  strapi.log.info(
    `[legacy-user-import] wachtwoord van gebruiker ${user.id} geupgraded van legacy MD5 naar bcrypt na succesvolle login.`,
  );
}

export default (plugin: any) => {
  const originalCallback = plugin.controllers.auth.callback;

  plugin.controllers.auth.callback = async (ctx: any) => {
    try {
      if (ctx.params?.provider === 'local') {
        const identifier = ctx.request?.body?.identifier;
        const password = ctx.request?.body?.password;

        if (typeof identifier === 'string' && typeof password === 'string') {
          await upgradeLegacyMd5PasswordIfNeeded(identifier, password);
        }
      }
    } catch (error) {
      // Deze legacy-shim mag NOOIT de echte login blokkeren, ook niet als hij
      // zelf een fout tegenkomt.
      strapi.log.error('[legacy-user-import] lazy MD5 password-upgrade check mislukt', error);
    }

    return originalCallback(ctx);
  };

  return plugin;
};
