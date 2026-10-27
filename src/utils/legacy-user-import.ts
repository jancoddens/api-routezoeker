import * as fs from 'node:fs';

// Importeert de bestaande accounts + nieuwsbriefvoorkeuren van de oude
// (PHP/MySQL) site naar Strapi, op basis van twee phpMyAdmin SQL-dumps
// (`Profiel` en `Nieuwsbrief_voorkeuren`) -- geen live verbinding met de
// oude MySQL-database nodig.
//
// BELANGRIJK -- lees dit voor je dit script draait:
//
// 1. Dit script moet lopen in een omgeving waar Strapi's eigen .env naar de
//    ECHTE productie-database wijst (dus op de VPS, niet op een lokale
//    dev-checkout met een lege sqlite-dev-db). Zie de waarschuwing die
//    hierover al in src/utils/legacy-poi-import.ts stond: eerdere imports
//    liepen hier al eens tegen aan.
// 2. Standaard draait dit script in --dry-run: er wordt NIETS weggeschreven,
//    enkel een rapport getoond van wat ZOU gebeuren. Voeg --no-dry-run TOE
//    (samen met --confirm-production) om écht te schrijven.
// 3. Wachtwoorden worden NOOIT in leesbare vorm gelogd of opgeslagen.
//    - Was het oude wachtwoord al een bcrypt-hash ($2y$/$2a$/$2b$, PHP's
//      password_hash()-formaat)? Dan wordt die hash 1-op-1 overgenomen.
//      Getest (zie scratchpad-testscript): bcryptjs 2.4.3 -- exact de versie
//      die dit project gebruikt -- valideert zo'n hash correct zonder enige
//      aanpassing. Deze gebruikers kunnen dus meteen inloggen met hun
//      bestaand wachtwoord, zonder reset.
//    - Was het nog een oud (ongesalt) MD5-wachtwoord? Dan wordt het veld
//      `password` gezet op `md5:<hun-md5-hash>` (nooit het plaintext-
//      wachtwoord, dat kennen we sowieso niet). De login-extensie in
//      src/extensions/users-permissions/strapi-server.ts herkent dat
//      voorvoegsel: bij hun eerstvolgende succesvolle login wordt het
//      wachtwoord automatisch en transparant geupgraded naar een normale
//      bcrypt-hash. Ook deze gebruikers hoeven dus hun wachtwoord niet te
//      resetten.
// 4. Dit script is idempotent: opnieuw draaien op dezelfde data maakt geen
//    duplicaten, maar update de reeds geimporteerde rijen (matching op
//    `legacy_user_controlnumber`, met e-mail als fallback).

type ProfielRow = {
  legacyId: string;
  userControlNumber: string;
  rechten: number;
  email: string;
  username: string;
  lastName: string; // 'Naam' in de oude tabel = achternaam
  firstName: string; // 'Voornaam' = voornaam
  passwordRaw: string;
  birthDate: string | null; // null = placeholder (1970-01-01) of onbruikbaar
  gender: string;
  postcode: string;
  country: string;
  walkingClub: string;
  createdAt: string;
  lastLoginAt: string | null; // null = placeholder (0000-00-00 ...)
  status: number;
  avatar: string;
};

type NewsletterRow = {
  legacyId: string;
  email: string;
  firstName: string;
  lastName: string;
  subscribedAt: string | null;
  subscribedVia: string;
  unsubscribedAt: string | null;
  unsubscribedVia: string;
  optin: number;
  status: number;
  userControlNumber: string;
};

export type ImportOptions = {
  profielSqlPath: string;
  newsletterSqlPath: string;
  dryRun: boolean;
  limit?: number;
  offset?: number;
};

export type ImportReport = {
  profiel: {
    totalRows: number;
    processed: number;
    created: number;
    updated: number;
    skipped: number;
    passwordFormats: { bcrypt: number; md5: number; unknown: number };
    statusZeroCount: number;
    elevatedRechtenRows: Array<{ email: string; rechten: number }>;
  };
  newsletter: {
    totalRows: number;
    processed: number;
    created: number;
    updated: number;
    matchedToUser: number;
    orphan: number;
    skippedInvalidEmail: number;
    failed: number;
  };
  warnings: string[];
  samples: Array<Record<string, unknown>>;
};

const USER_MODEL_UID = 'plugin::users-permissions.user';
const USER_PROFILE_UID = 'api::user-profile.user-profile';
const NEWSLETTER_UID = 'api::newsletter-subscription.newsletter-subscription';
const MAX_WARNINGS = 200;
const MAX_SAMPLES = 20;

// ---------------------------------------------------------------------------
// Zeer minimale phpMyAdmin-dump-parser: leest enkel de `INSERT INTO ... VALUES
// (...), (...), ...;`-blokken voor een gegeven tabel, en splitst elke
// tuple in zijn losse veldwaarden. Houdt rekening met aanhalingstekens,
// SQL-escapes (\') en verdubbelde quotes ('').
// ---------------------------------------------------------------------------

function splitSqlTuples(valuesBlob: string): string[][] {
  const tuples: string[][] = [];
  let i = 0;
  const n = valuesBlob.length;

  while (i < n) {
    if (valuesBlob[i] === '(') {
      let depth = 1;
      let j = i + 1;
      const fields: string[] = [];
      let cur = '';
      let inString = false;

      while (j < n && depth > 0) {
        const c = valuesBlob[j];

        if (inString) {
          if (c === '\\' && j + 1 < n) {
            cur += c + valuesBlob[j + 1];
            j += 2;
            continue;
          }
          if (c === "'") {
            if (valuesBlob[j + 1] === "'") {
              cur += "'";
              j += 2;
              continue;
            }
            inString = false;
            cur += c;
            j += 1;
            continue;
          }
          cur += c;
          j += 1;
          continue;
        }

        if (c === "'") {
          inString = true;
          cur += c;
          j += 1;
          continue;
        }
        if (c === '(') {
          depth += 1;
          cur += c;
          j += 1;
          continue;
        }
        if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            fields.push(cur);
            j += 1;
            break;
          }
          cur += c;
          j += 1;
          continue;
        }
        if (c === ',' && depth === 1) {
          fields.push(cur);
          cur = '';
          j += 1;
          continue;
        }
        cur += c;
        j += 1;
      }

      tuples.push(fields);
      i = j;
    } else {
      i += 1;
    }
  }

  return tuples;
}

function unquoteSqlString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/''/g, "'")
      .replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function parseInsertRows(sqlContent: string, tableName: string, columns: string[]): Record<string, string>[] {
  const pattern = new RegExp('INSERT INTO `' + tableName + '`[\\s\\S]*?VALUES\\s*([\\s\\S]*?);', 'g');
  const rows: Record<string, string>[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(sqlContent)) !== null) {
    const tuples = splitSqlTuples(match[1]);
    for (const tuple of tuples) {
      if (tuple.length !== columns.length) {
        continue;
      }
      const record: Record<string, string> = {};
      columns.forEach((col, idx) => {
        record[col] = unquoteSqlString(tuple[idx]);
      });
      rows.push(record);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Wachtwoord-classificatie
// ---------------------------------------------------------------------------

export function classifyPasswordHash(raw: string): 'bcrypt' | 'md5' | 'unknown' {
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(raw)) {
    return 'bcrypt';
  }
  if (/^[a-f0-9]{32}$/i.test(raw)) {
    return 'md5';
  }
  return 'unknown';
}

function normalizeDate(raw: string, placeholders: string[]): string | null {
  if (!raw || placeholders.includes(raw)) {
    return null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Parsing van de twee brondump-bestanden
// ---------------------------------------------------------------------------

function parseProfielSql(filePath: string): ProfielRow[] {
  const content = fs.readFileSync(filePath, 'utf8'); // dump is UTF-8, ondanks CHARSET=latin1 in de tabeldefinitie
  const columns = [
    'ID',
    'user_controlnumber',
    'Rechten',
    'Email',
    'Gebruikersnaam',
    'Naam',
    'Voornaam',
    'Wachtwoord',
    'Geboortedatum',
    'Geslacht',
    'Postcode',
    'Land',
    'Wandelclub',
    'Creatie_datum',
    'Laatste_login_datum',
    'Status',
    'Afbeelding',
  ];

  const rawRows = parseInsertRows(content, 'Profiel', columns);

  return rawRows.map((r) => {
    // Minstens 1 rij in de echte data (legacy ID 1516) heeft Email en
    // Gebruikersnaam per ongeluk omgewisseld (Email = "martine.vancompernolle",
    // Gebruikersnaam = "martine.vancompernolle@gmail.com"). Vangnet: als Email
    // geen '@' bevat maar Gebruikersnaam wel, wissel ze om i.p.v. deze
    // gebruiker gewoon over te slaan.
    let email = r.Email.trim();
    let username = r.Gebruikersnaam.trim();
    if (!email.includes('@') && username.includes('@')) {
      [email, username] = [username, email];
    }

    return {
    legacyId: r.ID,
    userControlNumber: r.user_controlnumber,
    rechten: Number(r.Rechten) || 0,
    email: email.toLowerCase(),
    username,
    lastName: r.Naam,
    firstName: r.Voornaam,
    passwordRaw: r.Wachtwoord,
    birthDate: normalizeDate(r.Geboortedatum, ['1970-01-01']),
    gender: r.Geslacht,
    postcode: r.Postcode,
    country: r.Land,
    walkingClub: r.Wandelclub,
    createdAt: r.Creatie_datum,
      lastLoginAt: normalizeDate(r.Laatste_login_datum, ['0000-00-00 00:00:00']),
      status: Number(r.Status) || 0,
      avatar: r.Afbeelding,
    };
  });
}

function parseNewsletterSql(filePath: string): NewsletterRow[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const columns = [
    'ID',
    'Email',
    'Name',
    'Lastname',
    'Inschrijvingsdatum',
    'Inschrijvingsmanier',
    'Uitschrijvingsdatum',
    'Uitschrijvingsmanier',
    'Optin',
    'Status',
    'user_controlnumber',
  ];

  const rawRows = parseInsertRows(content, 'Nieuwsbrief_voorkeuren', columns);

  return rawRows.map((r) => ({
    legacyId: r.ID,
    email: r.Email.trim().toLowerCase(),
    firstName: r.Name,
    lastName: r.Lastname,
    subscribedAt: normalizeDate(r.Inschrijvingsdatum, ['0000-00-00 00:00:00']),
    subscribedVia: r.Inschrijvingsmanier,
    unsubscribedAt: normalizeDate(r.Uitschrijvingsdatum, ['0000-00-00 00:00:00']),
    unsubscribedVia: r.Uitschrijvingsmanier,
    optin: Number(r.Optin) || 0,
    status: Number(r.Status) || 0,
    userControlNumber: r.user_controlnumber,
  }));
}

// ---------------------------------------------------------------------------
// Username-sanitizing (Strapi eist enkel uniciteit, geen vast formaat -- maar
// we deduplicaten toch defensief, want de brondata bevat geen garanties)
// ---------------------------------------------------------------------------

function buildUsernameAssigner() {
  const used = new Set<string>();

  return (candidate: string, fallbackSeed: string): string => {
    const base = candidate.trim() || fallbackSeed;
    let attempt = base;
    let suffix = 2;
    while (used.has(attempt.toLowerCase())) {
      attempt = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(attempt.toLowerCase());
    return attempt;
  };
}

// ---------------------------------------------------------------------------
// Hoofdimport
// ---------------------------------------------------------------------------

export async function importLegacyUsers(strapi: any, options: ImportOptions): Promise<ImportReport> {
  const dbConnection = strapi.config.get('database.connection.connection');
  const dbClient = strapi.config.get('database.connection.client');
  strapi.log.warn(
    `[legacy-user-import] Actieve database-connectie: client=${dbClient} filename=${dbConnection?.filename ?? '(n.v.t.)'} -- controleer dat dit de ECHTE productie-db is voor je --no-dry-run gebruikt.`,
  );

  const report: ImportReport = {
    profiel: {
      totalRows: 0,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      passwordFormats: { bcrypt: 0, md5: 0, unknown: 0 },
      statusZeroCount: 0,
      elevatedRechtenRows: [],
    },
    newsletter: {
      totalRows: 0,
      processed: 0,
      created: 0,
      updated: 0,
      matchedToUser: 0,
      orphan: 0,
      skippedInvalidEmail: 0,
      failed: 0,
    },
    warnings: [],
    samples: [],
  };

  const addWarning = (message: string) => {
    if (report.warnings.length < MAX_WARNINGS) {
      report.warnings.push(message);
    }
  };
  const addSample = (sample: Record<string, unknown>) => {
    if (report.samples.length < MAX_SAMPLES) {
      report.samples.push(sample);
    }
  };

  const profielRows = parseProfielSql(options.profielSqlPath);
  const newsletterRows = parseNewsletterSql(options.newsletterSqlPath);
  report.profiel.totalRows = profielRows.length;
  report.newsletter.totalRows = newsletterRows.length;

  const slice = options.offset || options.limit
    ? profielRows.slice(options.offset ?? 0, options.limit ? (options.offset ?? 0) + options.limit : undefined)
    : profielRows;

  const authenticatedRole = await strapi.db.query('plugin::users-permissions.role').findOne({
    where: { type: 'authenticated' },
  });
  if (!authenticatedRole) {
    throw new Error('Kon de "Authenticated"-rol niet vinden -- is users-permissions correct geinstalleerd?');
  }

  const assignUsername = buildUsernameAssigner();
  // Vult zich met de al-bestaande usernames zodat we niet tegen henzelf
  // botsen als het script een tweede keer draait.
  if (!options.dryRun) {
    const existingUsers = await strapi.db.query(USER_MODEL_UID).findMany({ select: ['username'] });
    // (enkel relevant om te vermijden dat een NIEUW aangemaakte gebruiker
    // toevallig dezelfde username krijgt als een reeds bestaande, niet-
    // geimporteerde gebruiker; matches met zichzelf bij een update zijn geen
    // probleem want die rij wordt geupdatet, niet opnieuw aangemaakt)
    for (const u of existingUsers) {
      assignUsername(u.username, u.username);
    }
  }

  // legacy_user_controlnumber -> Strapi user id, voor het koppelen van de
  // nieuwsbriefvoorkeuren nadien.
  const controlNumberToUserId = new Map<string, number>();

  for (const row of slice) {
    report.profiel.processed += 1;

    if (row.status === 0) {
      report.profiel.statusZeroCount += 1;
    }
    if (row.rechten >= 9) {
      report.profiel.elevatedRechtenRows.push({ email: row.email, rechten: row.rechten });
    }

    if (!row.email || !row.email.includes('@')) {
      addWarning(`Rij met legacy ID ${row.legacyId} heeft geen (geldig) e-mailadres -- overgeslagen.`);
      report.profiel.skipped += 1;
      continue;
    }

    const hashType = classifyPasswordHash(row.passwordRaw);
    report.profiel.passwordFormats[hashType] += 1;

    let passwordToStore: string;
    if (hashType === 'bcrypt') {
      passwordToStore = row.passwordRaw;
    } else if (hashType === 'md5') {
      passwordToStore = `md5:${row.passwordRaw.toLowerCase()}`;
    } else {
      addWarning(
        `Rij met legacy ID ${row.legacyId} (${row.email}) heeft een onherkend wachtwoordformaat -- gebruiker wordt aangemaakt met een onbruikbaar wachtwoord; deze persoon moet een "wachtwoord vergeten" doen.`,
      );
      passwordToStore = await bcryptPlaceholder();
    }

    let existingUser = await strapi.db.query(USER_MODEL_UID).findOne({
      where: { email: row.email },
    });

    if (!existingUser) {
      const existingProfile = await strapi.entityService.findMany(USER_PROFILE_UID, {
        filters: { legacy_user_controlnumber: row.userControlNumber },
        populate: ['user'],
        limit: 1,
      });
      if (existingProfile?.[0]?.user) {
        existingUser = existingProfile[0].user;
      }
    }

    const username = existingUser?.username ?? assignUsername(row.username, row.email.split('@')[0]);

    const userData = {
      username,
      email: row.email,
      password: passwordToStore,
      provider: 'local',
      confirmed: true,
      blocked: false,
      role: authenticatedRole.id,
    };

    let userId: number;

    if (options.dryRun) {
      userId = existingUser?.id ?? -1;
      if (existingUser) {
        report.profiel.updated += 1;
      } else {
        report.profiel.created += 1;
      }
    } else if (existingUser) {
      // Wachtwoord van een reeds bestaande Strapi-gebruiker NOOIT overschrijven
      // bij een herimport -- enkel de profielgegevens bijwerken. Zo kan dit
      // script veilig herhaald worden nadat iemand al eens is ingelogd (en dus
      // een legacy MD5-wachtwoord al geupgraded is naar bcrypt).
      const { password: _ignoredPassword, ...updateData } = userData;
      await strapi.db.query(USER_MODEL_UID).update({
        where: { id: existingUser.id },
        data: updateData,
      });
      userId = existingUser.id;
      report.profiel.updated += 1;
    } else {
      const created = await strapi.db.query(USER_MODEL_UID).create({ data: userData });
      userId = created.id;
      report.profiel.created += 1;
    }

    controlNumberToUserId.set(row.userControlNumber, userId);

    if (!options.dryRun) {
      const profileData = {
        first_name: row.firstName,
        last_name: row.lastName,
        locale: 'nl',
        postcode: row.postcode || null,
        birth_date: row.birthDate,
        gender: row.gender || null,
        walking_club: row.walkingClub || null,
        avatar_url: row.avatar || null,
        legacy_user_controlnumber: row.userControlNumber,
        legacy_rechten: row.rechten,
        legacy_status: row.status,
        legacy_created_at: row.createdAt,
        legacy_last_login_at: row.lastLoginAt,
        user: userId,
      };

      const existingProfileForUser = await strapi.entityService.findMany(USER_PROFILE_UID, {
        filters: { user: userId },
        limit: 1,
      });

      if (existingProfileForUser?.[0]) {
        await strapi.entityService.update(USER_PROFILE_UID, existingProfileForUser[0].id, { data: profileData });
      } else {
        await strapi.entityService.create(USER_PROFILE_UID, { data: profileData });
      }
    }

    if (report.samples.length < MAX_SAMPLES) {
      addSample({
        legacyId: row.legacyId,
        email: row.email,
        username,
        passwordFormat: hashType,
        action: existingUser ? 'update' : 'create',
      });
    }
  }

  // --- Nieuwsbriefvoorkeuren ---
  for (const row of newsletterRows) {
    report.newsletter.processed += 1;

    // Zelfde soort check als Strapi's eigen email-validatie: een ongeldig
    // adres (spatie, geen punt in het domein, ...) zou anders de hele import
    // laten crashen bij entityService.create.
    if (!row.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
      addWarning(
        `Nieuwsbrief-rij met legacy ID ${row.legacyId} heeft geen geldig e-mailadres (${JSON.stringify(row.email)}) -- overgeslagen.`,
      );
      report.newsletter.skippedInvalidEmail += 1;
      continue;
    }

    const matchedUserId = controlNumberToUserId.get(row.userControlNumber);
    if (matchedUserId) {
      report.newsletter.matchedToUser += 1;
    } else {
      report.newsletter.orphan += 1;
    }

    const isUnsubscribed = row.optin === 0 || Boolean(row.unsubscribedAt);
    const subscriptionData = {
      email: row.email,
      status: isUnsubscribed ? 'unsubscribed' : 'subscribed',
      source: 'import',
      consent_at: row.subscribedAt,
      confirmed_at: row.subscribedAt,
      unsubscribed_at: row.unsubscribedAt,
      user: matchedUserId ?? null,
    };

    if (options.dryRun) {
      report.newsletter.updated += 1; // in dry-run tellen we alles samen als "zou verwerkt worden"
      continue;
    }

    // Eén foute rij mag nooit de rest van de nieuwsbrief-import tegenhouden.
    try {
      const existing = await strapi.entityService.findMany(NEWSLETTER_UID, {
        filters: { email: row.email },
        limit: 1,
      });

      if (existing?.[0]) {
        await strapi.entityService.update(NEWSLETTER_UID, existing[0].id, { data: subscriptionData });
        report.newsletter.updated += 1;
      } else {
        await strapi.entityService.create(NEWSLETTER_UID, { data: subscriptionData });
        report.newsletter.created += 1;
      }
    } catch (error: any) {
      report.newsletter.failed += 1;
      const details = error?.details?.errors ? ` ${JSON.stringify(error.details.errors)}` : '';
      addWarning(
        `Nieuwsbrief-rij met legacy ID ${row.legacyId} (${row.email}) kon niet worden opgeslagen: ${error?.message ?? error}${details}`,
      );
    }
  }

  return report;
}

async function bcryptPlaceholder(): Promise<string> {
  const bcrypt = await import('bcryptjs');
  const random = require('node:crypto').randomBytes(24).toString('hex');
  return bcrypt.hash(random, 10);
}
