#!/usr/bin/env node

'use strict';

// Read-only helper: lists legacy MySQL tables that look related to the
// "punten"/POI content (Wandelnetwerken/Gebouwen/Locaties shown on Full-tier
// logies pages) plus the logies/partner table, so we know the exact schema
// before writing a real import script. Does NOT touch Strapi or write
// anything, anywhere.
//
// Usage:
//   node scripts/inspect-legacy-poi-tables.js
//   node scripts/inspect-legacy-poi-tables.js --config /pad/naar/config.php
//   node scripts/inspect-legacy-poi-tables.js --like "%punt%,%poi%,%locatie%,%gebouw%,%monument%,%logie%,%partner%"
//   node scripts/inspect-legacy-poi-tables.js --password ietsAnders --user routezoeker --host localhost --database front_routezoeker
//
// De --host/--user/--password/--database flags overschrijven wat er uit
// config.php gehaald wordt, handig als dat bestand een verouderd wachtwoord
// bevat.

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_LEGACY_ROOT = '/Users/jancoddens/Documents/Websites/Routezoeker.com/V4';
const DEFAULT_LIKE_PATTERNS = [
  '%punt%',
  '%poi%',
  '%locatie%',
  '%gebouw%',
  '%monument%',
  '%logie%',
  '%partner%',
  '%accommodatie%',
];

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    configPath: path.join(DEFAULT_LEGACY_ROOT, 'config.php'),
    likePatterns: DEFAULT_LIKE_PATTERNS,
    hostOverride: undefined,
    userOverride: undefined,
    passwordOverride: undefined,
    databaseOverride: undefined,
    portOverride: undefined,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--config') {
      options.configPath = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--like') {
      options.likePatterns = rawArgs[index + 1].split(',').map((value) => value.trim());
      index += 1;
      continue;
    }

    if (arg === '--host') {
      options.hostOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--user') {
      options.userOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--password') {
      options.passwordOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--database') {
      options.databaseOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--port') {
      options.portOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
};

const parsePhpConfig = async (configPath) => {
  const raw = await fs.readFile(configPath, 'utf8');
  const extract = (variable) => raw.match(new RegExp(`\\$${variable}\\s*=\\s*'([^']*)'`, 'i'))?.[1] ?? null;

  const host = extract('dbhost');
  const user = extract('dbuser');
  const password = extract('dbpass');
  const database = extract('dbname');

  if (!host || !user || password === null || !database) {
    throw new Error(`Could not parse database credentials from ${configPath}`);
  }

  return { host, user, password, database };
};

const runMysqlQuery = async (config, sql) => {
  const args = ['--batch', '--raw', '-h', config.host, '-u', config.user, '-D', config.database, '-e', sql];

  if (config.port) {
    args.splice(6, 0, '-P', String(config.port));
  }

  const { stdout } = await execFileAsync('mysql', args, {
    env: { ...process.env, MYSQL_PWD: config.password },
    maxBuffer: 1024 * 1024 * 20,
  });

  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const header = lines[0]?.split('\t') ?? [];

  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((column, index) => {
      row[column] = cells[index];
    });
    return row;
  });
};

const run = async () => {
  const options = parseArgs();
  const parsedConfig = await parsePhpConfig(options.configPath);
  const config = {
    host: options.hostOverride || parsedConfig.host,
    user: options.userOverride || parsedConfig.user,
    password:
      options.passwordOverride !== undefined ? options.passwordOverride : parsedConfig.password,
    database: options.databaseOverride || parsedConfig.database,
    port: options.portOverride,
  };

  const likeClause = options.likePatterns.map((pattern) => `table_name LIKE '${pattern}'`).join(' OR ');
  const tables = await runMysqlQuery(
    config,
    `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = '${config.database}' AND (${likeClause}) ORDER BY table_name`
  );

  if (tables.length === 0) {
    console.log('Geen tabellen gevonden die matchen met:', options.likePatterns.join(', '));
    console.log('Alle tabellen in de database:');
    const allTables = await runMysqlQuery(
      config,
      `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = '${config.database}' ORDER BY table_name`
    );
    console.log(JSON.stringify(allTables, null, 2));
    return;
  }

  const result = [];

  for (const table of tables) {
    const tableName = table.TABLE_NAME || table.table_name;
    const columns = await runMysqlQuery(config, `DESCRIBE \`${tableName}\``);
    const sampleRows = await runMysqlQuery(config, `SELECT * FROM \`${tableName}\` LIMIT 2`);

    result.push({
      table: tableName,
      approxRowCount: table.TABLE_ROWS || table.table_rows,
      columns: columns.map((column) => column.Field || column.field),
      sampleRows,
    });
  }

  console.log(JSON.stringify(result, null, 2));
};

run().catch((error) => {
  if (error?.code === 'ENOENT' && String(error?.path || '').endsWith('config.php')) {
    console.error(
      'Legacy config.php niet gevonden. Gebruik --config /pad/naar/config.php.'
    );
  }

  console.error(error);
  process.exit(1);
});
