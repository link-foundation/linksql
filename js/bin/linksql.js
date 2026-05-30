#!/usr/bin/env node

/**
 * LinksQL command-line interface.
 *
 * A thin wrapper over the public API in the spirit of link-cli: run queries,
 * import/export the link store as LiNo, and serve the database over HTTP.
 *
 *   linksql query "() ((alice loves bob))" --db people.lino
 *   linksql export --db people.lino
 *   linksql import people.lino --db store.lino
 *   linksql serve --db store.lino --port 8080
 */

import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Database, LinksQLServer } from '../src/index.js';

/** Render the help text. */
function usage() {
  return [
    'Usage: linksql <command> [options]',
    '',
    'Commands:',
    '  query <lino>   Run a query; prints a JSON report',
    '  serve          Start the HTTP server (Ctrl-C to stop)',
    '  import <file>  Import LiNo from a file into the store',
    '  export         Print the whole store as canonical LiNo',
    '',
    'Options:',
    '  --db <path>        LiNo file used as the persistent store',
    '  --port <n>         Port for `serve` (default 8080)',
    '  --host <host>      Host for `serve` (default 127.0.0.1)',
    '  --no-auto-create   Do not auto-create unknown named references',
    '  --help, -h         Show this help',
    '  --version, -v      Show the package version',
  ].join('\n');
}

/** Read the package version from package.json. */
function readVersion() {
  const packageUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(packageUrl, 'utf8')).version;
}

/** Parse argv into options and positional arguments. */
function parseArgs(argv) {
  const options = {
    db: null,
    port: 8080,
    host: '127.0.0.1',
    autoCreate: true,
    help: false,
    version: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      options.db = argv[(i += 1)];
    } else if (arg === '--port') {
      options.port = Number(argv[(i += 1)]);
    } else if (arg === '--host') {
      options.host = argv[(i += 1)];
    } else if (arg === '--no-auto-create') {
      options.autoCreate = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else {
      positionals.push(arg);
    }
  }
  return { options, positionals };
}

/** Build a database, loading the store file when one is configured. */
function loadDatabase(options) {
  const db = new Database({ autoCreate: options.autoCreate });
  if (options.db && existsSync(options.db)) {
    db.importLino(readFileSync(options.db, 'utf8'));
  }
  return db;
}

/** Persist a database to the store file, if one is configured. */
function saveDatabase(db, options) {
  if (options.db) {
    const text = db.toLino();
    writeFileSync(options.db, text ? `${text}\n` : '');
  }
}

/** Handle the `query` command. */
function commandQuery(options, positionals, io) {
  const text = positionals[1];
  if (!text) {
    io.stderr('query requires a LiNo argument');
    return 1;
  }
  const db = loadDatabase(options);
  const report = db.query(text);
  saveDatabase(db, options);
  io.stdout(JSON.stringify(report, null, 2));
  return 0;
}

/** Handle the `import` command. */
function commandImport(options, positionals, io) {
  const file = positionals[1];
  if (!file) {
    io.stderr('import requires a file argument');
    return 1;
  }
  const db = loadDatabase(options);
  const imported = db.importLino(readFileSync(file, 'utf8'));
  saveDatabase(db, options);
  io.stdout(`Imported ${imported} link(s)`);
  return 0;
}

/** Handle the `export` command. */
function commandExport(options, io) {
  const db = loadDatabase(options);
  io.stdout(db.toLino());
  return 0;
}

/** Handle the `serve` command, returning the running server. */
async function commandServe(options, io) {
  const db = loadDatabase(options);
  const server = new LinksQLServer({ database: db, version: readVersion() });
  await server.listen(options.port, options.host);
  io.stdout(`LinksQL server listening on ${server.url}`);
  return server;
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv - Arguments after the node binary and script.
 * @param {object} [io] - Injectable `stdout`/`stderr` for testing.
 * @returns {Promise<number|LinksQLServer>} An exit code, or the running server
 *   for the `serve` command.
 */
export async function runCli(
  argv,
  { stdout = console.log, stderr = console.error } = {}
) {
  const io = { stdout, stderr };
  const { options, positionals } = parseArgs(argv);
  const command = positionals[0];

  if (options.version) {
    io.stdout(readVersion());
    return 0;
  }
  if (options.help || !command) {
    io.stdout(usage());
    return 0;
  }

  try {
    if (command === 'query') {
      return commandQuery(options, positionals, io);
    }
    if (command === 'import') {
      return commandImport(options, positionals, io);
    }
    if (command === 'export') {
      return commandExport(options, io);
    }
    if (command === 'serve') {
      return await commandServe(options, io);
    }
    io.stderr(`Unknown command: ${command}`);
    io.stderr(usage());
    return 1;
  } catch (error) {
    io.stderr(error.message);
    return 1;
  }
}

/** Whether this module is being run directly as the CLI entry point. */
function isCliEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  const result = await runCli(process.argv.slice(2));
  if (typeof result === 'number') {
    process.exitCode = result;
  }
}
