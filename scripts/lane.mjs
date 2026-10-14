#!/usr/bin/env node
// One local Supabase stack per agent ("lane"), and the commands that drive it. Task DB01.
//
//   LANE=a npm run db:start         start the lane's stack (a cold start takes under a minute once the images are cached)
//   LANE=a npm run db:stop          stop it, keeping its data   (add `-- --no-backup` to delete its volumes)
//   LANE=a npm run db:reset         empty database + migrations + seeds
//   LANE=a npm run db:test          reset, then the pgTAP tests (supabase test db neither migrates nor seeds)
//   LANE=a npm run db:test:2        the Vitest tests over two connections and over HTTP
//   LANE=a npm run db:check         T-F04: the migrations applied twice give the same schema, the advisor is clean
//   LANE=a npm run verify           every gate before anything is called ready to push
//   LANE=a npm run lane -- <command>  psql, run, status, ports, env, fingerprint, advisors ...  (see `help`)
//
// A lane is main, a, b or c. Each has its own work folder .lanes/<lane>/ (never committed) that holds the committed
// supabase/config.toml with its own project id (jv-<lane>) and its own port block, and links to the committed
// migrations, tests and seeds. Two stacks with the same project id or the same ports cannot run together, and one
// lane's `db reset` would wipe another's data, so a lane never touches a stack that is not its own.

import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------------------------------------ lanes and ports

export const LANES = ['main', 'a', 'b', 'c'];
const PORT_STEP = 1000; // main 443xx, a 453xx, b 463xx, c 473xx
const DEV_PORT_BASE = 4028; // the dev server of lane main; a is 4128, b 4228, c 4328
const DEV_PORT_STEP = 100;
const FIRST_DYNAMIC_PORT = 49152; // where the operating system starts handing out temporary ports
const FIRST_USABLE_PORT = 1024;

/**
 * The lane name, or an error that says what to type.
 * @param {string | undefined} name
 * @returns {string}
 */
export function assertLane(name) {
  if (!name) {
    throw new Error(
      `LANE is not set. Pick one of ${LANES.join(', ')}, for example: LANE=a npm run db:start`
    );
  }
  if (!LANES.includes(name)) {
    throw new Error(`Unknown lane "${name}". The lanes are ${LANES.join(', ')}.`);
  }
  return name;
}

/** @param {string} lane */
export const laneIndex = (lane) => LANES.indexOf(assertLane(lane));
/** @param {string} lane */
export const projectId = (lane) => `jv-${assertLane(lane)}`;
/** @param {string} lane */
export const devPort = (lane) => DEV_PORT_BASE + DEV_PORT_STEP * laneIndex(lane);
/** @param {string} lane */
const portOffset = (lane) => PORT_STEP * laneIndex(lane);

/**
 * Every active (not commented) port of a config file, by `section.key`.
 * @param {string} configText
 * @returns {Record<string, number>}
 */
export function parsePorts(configText) {
  /** @type {Record<string, number>} */
  const ports = {};
  let section = '';
  for (const raw of configText.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const kv = /^((?:shadow_|inspector_|smtp_|pop3_)?port)\s*=\s*(\d+)\b/.exec(line);
    if (kv) ports[`${section}.${kv[1]}`] = Number(kv[2]);
  }
  return ports;
}

/** @type {Record<string, string>} */
const PORT_NAMES = {
  'api.port': 'api',
  'db.port': 'db',
  'db.shadow_port': 'shadow',
  'db.pooler.port': 'pooler',
  'studio.port': 'studio',
  'local_smtp.port': 'smtp',
  'analytics.port': 'analytics',
};

const committedConfigText = () => readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8');

/**
 * Named ports of a lane (the committed main block moved by the lane's offset).
 * @param {string} lane
 * @param {string} [configText]
 * @returns {Record<string, number>}
 */
export function lanePorts(lane, configText = committedConfigText()) {
  const offset = portOffset(lane);
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, port] of Object.entries(parsePorts(configText))) {
    out[PORT_NAMES[key] ?? key] = port + offset;
  }
  return out;
}

/**
 * The committed config for one lane: its own project id, its own ports, its own dev-server URL.
 * @param {string} configText
 * @param {string} lane
 * @returns {string}
 */
export function renderLaneConfig(configText, lane) {
  const offset = portOffset(lane);
  const dev = devPort(lane);
  if (!/^project_id\s*=\s*".*"\s*$/m.test(configText)) {
    throw new Error('supabase/config.toml has no project_id line');
  }
  const lines = configText.split('\n').map((line) => {
    if (/^project_id\s*=/.test(line)) return `project_id = "${projectId(lane)}"`;
    const port = /^(\s*)((?:shadow_|inspector_|smtp_|pop3_)?port)(\s*=\s*)(\d+)\b(.*)$/.exec(line);
    if (port) {
      const shifted = Number(port[4]) + offset;
      if (shifted < FIRST_USABLE_PORT || shifted >= FIRST_DYNAMIC_PORT) {
        throw new Error(
          `${port[2]} = ${port[4]} moves to ${shifted} in lane ${lane}, outside the valid range ${FIRST_USABLE_PORT} to ${
            FIRST_DYNAMIC_PORT - 1
          } (the operating system uses ${FIRST_DYNAMIC_PORT} and above)`
        );
      }
      return `${port[1]}${port[2]}${port[3]}${shifted}${port[5]}`;
    }
    if (/^\s*(site_url|additional_redirect_urls)\s*=/.test(line)) {
      return line.replace(`:${DEV_PORT_BASE}`, `:${dev}`);
    }
    return line;
  });
  return [
    `# Generated by scripts/lane.mjs from supabase/config.toml for lane "${lane}". Do not edit: changes are lost.`,
    ...lines,
  ].join('\n');
}

/**
 * True when nothing listens on the port (checked on all interfaces, as Docker publishes it).
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

// ------------------------------------------------------------------------------------------------ env file

const ENV_MARKER_START = '# Written by scripts/lane.mjs.';
export const ENV_MARKER = `${ENV_MARKER_START} Local only, never committed; the next db:start rewrites it.`;

/**
 * The .env.local of a lane: public values only (the API URL, the publishable key, the local database URL, the port).
 * @param {string} lane
 * @param {{ apiUrl: string, dbUrl: string, publishableKey: string }} values
 * @returns {string}
 */
export function renderEnvLocal(lane, { apiUrl, dbUrl, publishableKey }) {
  return (
    [
      ENV_MARKER,
      `JV_LANE=${lane}`,
      `NEXT_PUBLIC_SUPABASE_URL=${apiUrl}`,
      `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${publishableKey}`,
      `DATABASE_URL=${dbUrl}`,
      `PORT=${devPort(lane)}`,
    ].join('\n') + '\n'
  );
}

// ------------------------------------------------------------------------------------------------ verify plan

// The order of the brief: typecheck, lint, unit, db:check, db:test, db:test:2, build, build check. A step whose script
// does not exist yet is skipped by name, with the task that adds it, and the report names it.
const VERIFY_STEPS = [
  { name: 'typecheck', script: 'typecheck' },
  { name: 'lint (changed files)', script: 'lint:changed' },
  { name: 'unit', script: 'test' },
  { name: 'db:check', script: 'db:check', needsLane: true },
  { name: 'db:test', script: 'db:test', needsLane: true },
  { name: 'db:test:2', script: 'db:test:2', needsLane: true },
  { name: 'build', script: 'build' },
  { name: 'build check', script: 'build:check', task: 'FE06' },
  { name: 'e2e', script: 'test:e2e', task: 'FE02' },
];

/**
 * @param {Record<string, string>} scripts the scripts of package.json
 * @returns {Array<{ name: string, script: string, task?: string, needsLane: boolean, skip?: string }>}
 */
export function planVerify(scripts) {
  return VERIFY_STEPS.map((step) => ({
    ...step,
    needsLane: Boolean(step.needsLane),
    skip: !scripts[step.script] && step.task ? `skipped (task ${step.task})` : undefined,
  }));
}

/**
 * The files ESLint should look at: source files that still exist.
 * @param {string[]} files
 * @param {(file: string) => boolean} [exists]
 * @returns {string[]}
 */
export function lintTargets(files, exists = (file) => existsSync(file)) {
  return files.filter((file) => /\.[cm]?[jt]sx?$/.test(file) && exists(file));
}

// ------------------------------------------------------------------------------------------------ migration rules (S9)

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+\.sql$/;
const IDENT = '(?:"[^"]+"|[\\w$]+)';
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const CREATE_TABLE = new RegExp(
  `\\bcreate\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(${QUALIFIED})`,
  'gi'
);
const ENABLE_RLS = new RegExp(
  `\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QUALIFIED})\\s+enable\\s+row\\s+level\\s+security\\b`,
  'gi'
);

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');

function tableName(raw) {
  const parts = raw
    .replace(/\s+/g, '')
    .split('.')
    .map((part) => part.replace(/"/g, '').toLowerCase());
  return parts.length === 1 ? `public.${parts[0]}` : parts.join('.');
}

/**
 * The rules of S9 that need no database: names, versions, and row-level security in the file that creates a table.
 * @param {string} dir
 * @returns {Array<{ file: string, message: string }>}
 */
export function lintMigrationFiles(dir) {
  /** @type {Array<{ file: string, message: string }>} */
  const problems = [];
  if (!existsSync(dir)) return problems;
  const files = readdirSync(dir)
    .filter((file) => file !== '.gitkeep')
    .sort();
  const versions = new Map();
  for (const file of files) {
    if (!MIGRATION_NAME.test(file)) {
      problems.push({
        file,
        message:
          'the name must be <14 digit version>_<lowercase words>.sql, as `supabase migration new` makes it',
      });
      continue;
    }
    const version = file.slice(0, 14);
    if (versions.has(version)) {
      problems.push({ file, message: `has the same version as ${versions.get(version)}` });
    } else {
      versions.set(version, file);
    }
    const sql = stripComments(readFileSync(path.join(dir, file), 'utf8'));
    if (sql.trim() === '') {
      problems.push({ file, message: 'is empty' });
      continue;
    }
    const enabled = new Set([...sql.matchAll(ENABLE_RLS)].map((m) => tableName(m[1])));
    for (const created of new Set([...sql.matchAll(CREATE_TABLE)].map((m) => tableName(m[1])))) {
      if (!enabled.has(created)) {
        problems.push({
          file,
          message: `creates table ${created} but does not run "alter table ${created} enable row level security" in the same file (S9, A1)`,
        });
      }
    }
  }
  return problems;
}

/**
 * `git diff --name-status <merge base>` lines for supabase/migrations: a merged migration is only ever added to.
 * @param {string} nameStatus
 * @returns {Array<{ file: string, message: string }>}
 */
export function forwardOnlyProblems(nameStatus) {
  /** @type {Array<{ file: string, message: string }>} */
  const problems = [];
  for (const line of nameStatus.split('\n')) {
    const [status, ...paths] = line.split('\t');
    if (!status || status.startsWith('A')) continue;
    for (const file of paths) {
      if (file.startsWith('supabase/migrations/') && path.basename(file) !== '.gitkeep') {
        problems.push({
          file: file.replace('supabase/migrations/', ''),
          message: `status ${status}: a migration that is already merged is never edited, deleted or renamed; add a new migration instead`,
        });
        break;
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------ fingerprints

/**
 * Same text, or the lines that differ (prefixed - for the first, + for the second).
 * @param {string} first
 * @param {string} second
 * @returns {{ same: boolean, diff: string }}
 */
export function compareFingerprints(first, second) {
  if (first === second) return { same: true, diff: '' };
  const a = first.split('\n');
  const b = second.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const count = (lines) => {
    const seen = new Map();
    for (const line of lines) seen.set(line, (seen.get(line) ?? 0) + 1);
    return seen;
  };
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const inB = count(midB);
  const inA = count(midA);
  const removed = midA.filter((line) => {
    const left = inB.get(line) ?? 0;
    if (left > 0) {
      inB.set(line, left - 1);
      return false;
    }
    return true;
  });
  const added = midB.filter((line) => {
    const left = inA.get(line) ?? 0;
    if (left > 0) {
      inA.set(line, left - 1);
      return false;
    }
    return true;
  });
  const diff = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)];
  return {
    same: false,
    diff: diff.length ? diff.join('\n') : '(the same lines in a different order)',
  };
}

// What a schema dump leaves out: settings of roles (cluster level), the storage buckets and cron jobs that migrations
// write, and the extension versions. The event triggers and the default privileges are in the dump.
const FINGERPRINT_EXTRAS_SQL = `
select 'role-setting ' || coalesce(r.rolname, '*') || ' in ' || coalesce(d.datname, '*') || ' ' || array_to_string(s.setconfig, ' ')
  from pg_db_role_setting s
  left join pg_roles r on r.oid = s.setrole
  left join pg_database d on d.oid = s.setdatabase
 order by 1;
select 'extension ' || extname || ' ' || extversion from pg_extension order by 1;
select 'bucket ' || id || ' public=' || public || ' size=' || coalesce(file_size_limit::text, '-')
       || ' mime=' || coalesce(array_to_string(allowed_mime_types, ','), '-')
  from storage.buckets order by 1;
select to_regclass('cron.job') is not null as has_cron \\gset
\\if :has_cron
select 'cron-job ' || jobname || ' ' || schedule || ' ' || command from cron.job order by 1;
\\endif
`;

// ------------------------------------------------------------------------------------------------ the Supabase CLI and Docker

const info = (message) => console.info(message);
function die(message) {
  console.error(`lane: ${message}`);
  process.exit(1);
}

const laneDir = (lane) => path.join(ROOT, '.lanes', lane);
const dbContainer = (lane) => `supabase_db_${projectId(lane)}`;

function supabaseBin() {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'supabase');
  if (!existsSync(bin)) die('the Supabase CLI is not installed here. Run: npm ci');
  return bin;
}

function assertDocker() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0)
    die('Docker is not running. Start Docker Desktop first.');
}

function isRunning(lane) {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', `name=^${dbContainer(lane)}$`, '--filter', 'status=running', '-q'],
    { encoding: 'utf8' }
  );
  return result.status === 0 && result.stdout.trim() !== '';
}

function volumeCount() {
  const result = spawnSync('docker', ['volume', 'ls', '-q'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean).length : -1;
}

/** Runs the pinned Supabase CLI against the lane's work folder. */
function supabase(lane, args, options = {}) {
  return spawnSync(supabaseBin(), [...args, '--workdir', laneDir(lane)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
}

function linkFolder(inside, name, target) {
  const link = path.join(inside, name);
  const wanted = path.relative(inside, target);
  if (!existsSync(target)) die(`${path.relative(ROOT, target)} is missing`);
  let current = null;
  try {
    current = lstatSync(link);
  } catch {
    // no link yet
  }
  if (current) {
    if (current.isSymbolicLink() && readlinkSync(link) === wanted) return;
    if (!current.isSymbolicLink()) die(`${link} exists and is not a link; remove it by hand`);
    rmSync(link);
  }
  symlinkSync(wanted, link);
}

/** Writes .lanes/<lane>/ (config, links) and returns its path. Safe to repeat. */
export function prepareLane(lane) {
  assertLane(lane);
  const dir = laneDir(lane);
  const inside = path.join(dir, 'supabase');
  mkdirSync(inside, { recursive: true });
  const rendered = renderLaneConfig(committedConfigText(), lane);
  const target = path.join(inside, 'config.toml');
  if (!existsSync(target) || readFileSync(target, 'utf8') !== rendered)
    writeFileSync(target, rendered);
  for (const name of ['migrations', 'tests', 'seeds']) {
    linkFolder(inside, name, path.join(ROOT, 'supabase', name));
  }
  return dir;
}

/** What `supabase status` says about a running stack, or null. */
function readStatus(lane) {
  const result = spawnSync(supabaseBin(), ['status', '-o', 'json', '--workdir', laneDir(lane)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout.includes('{')) return null;
  try {
    const json = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    return {
      apiUrl: json.API_URL,
      dbUrl: json.DB_URL,
      publishableKey: json.PUBLISHABLE_KEY,
      secretKey: json.SECRET_KEY,
    };
  } catch {
    return null;
  }
}

/** The environment a command needs to reach the lane's stack. The secret key goes to child processes only. */
function laneEnv(lane, status) {
  return {
    JV_LANE: lane,
    LANE: lane,
    NEXT_PUBLIC_SUPABASE_URL: status.apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.publishableKey,
    DATABASE_URL: status.dbUrl,
    PORT: String(devPort(lane)),
    JV_SECRET_KEY: status.secretKey,
  };
}

function writeEnvFiles(lane, status) {
  const text = renderEnvLocal(lane, status);
  mkdirSync(laneDir(lane), { recursive: true });
  writeFileSync(path.join(laneDir(lane), '.env.local'), text);
  const root = path.join(ROOT, '.env.local');
  if (!existsSync(root) || readFileSync(root, 'utf8').startsWith(ENV_MARKER_START)) {
    writeFileSync(root, text);
  } else {
    info(
      'lane: .env.local at the top of the repository was not written by this tool, so it was left alone.'
    );
    info(`lane: the lane's own copy is .lanes/${lane}/.env.local`);
  }
}

async function waitForApi(status, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const headers = { apikey: status.publishableKey };
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const [auth, rest, storage] = await Promise.all([
        fetch(`${status.apiUrl}/auth/v1/health`, { headers }),
        fetch(`${status.apiUrl}/rest/v1/`, { headers }),
        fetch(`${status.apiUrl}/storage/v1/status`, { headers }),
      ]);
      last = `auth ${auth.status}, rest ${rest.status}, storage ${storage.status}`;
      if (auth.ok && rest.status < 500 && storage.status < 500) return;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  die(`the API did not become ready within ${timeoutMs / 1000} s (${last})`);
}

function psql(lane, sql, extraArgs = []) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      dbContainer(lane),
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      ...extraArgs,
    ],
    { input: sql, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr || result.error}`);
  return result.stdout;
}

// ------------------------------------------------------------------------------------------------ commands

async function cmdStart(lane) {
  assertDocker();
  prepareLane(lane);
  const wasRunning = isRunning(lane);
  if (!wasRunning) {
    const config = lanePorts(lane);
    for (const [name, port] of [
      ['api', config.api],
      ['db', config.db],
    ]) {
      if (!(await isPortFree(port))) {
        die(
          `port ${port} (${name} of lane ${lane}) is already in use by something that is not this lane's stack. ` +
            `Find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`
        );
      }
    }
  }
  const started = Date.now();
  // stdout carries the local keys, so it is read here and not echoed; the progress lines are on stderr.
  const result = supabase(lane, ['start'], { stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) die(`supabase start failed (exit ${result.status})`);
  const status = readStatus(lane);
  if (!status) die('the stack started but its status could not be read');
  await waitForApi(status);
  writeEnvFiles(lane, status);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ports = lanePorts(lane);
  info(
    `lane ${lane}: ${wasRunning ? 'already running' : 'up'} (${seconds} s). API ${status.apiUrl}, ` +
      `database port ${ports.db}, dev server port ${devPort(lane)}. Settings: .lanes/${lane}/.env.local`
  );
}

function cmdStop(lane, args) {
  assertDocker();
  const unknown = args.filter((arg) => arg !== '--no-backup');
  if (unknown.length) die(`unknown option ${unknown.join(' ')} (the only one is --no-backup)`);
  prepareLane(lane);
  const before = volumeCount();
  const result = supabase(lane, ['stop', ...args]);
  if (result.status !== 0) die(`supabase stop failed (exit ${result.status})`);
  info(
    `lane ${lane}: stopped${args.includes('--no-backup') ? ', volumes deleted' : ', volumes kept'}. ` +
      `Docker volumes: ${before} before, ${volumeCount()} now.`
  );
}

async function ensureRunning(lane) {
  if (!isRunning(lane)) await cmdStart(lane);
  const status = readStatus(lane);
  if (!status) die(`could not read the status of lane ${lane}`);
  return status;
}

async function cmdReset(lane, args) {
  const allowed = new Set(['--no-seed']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length) die(`unknown option ${unknown.join(' ')} (the only one is --no-seed)`);
  const status = await ensureRunning(lane);
  const result = supabase(lane, ['db', 'reset', '--local', ...args]);
  if (result.status !== 0) die(`supabase db reset failed (exit ${result.status})`);
  await waitForApi(status);
  writeEnvFiles(lane, status);
}

async function cmdTestPgTap(lane, args) {
  await cmdReset(lane, []);
  const result = supabase(lane, ['test', 'db', '--local', ...args]);
  process.exit(result.status ?? 1);
}

async function cmdTestTwoConnections(lane, args) {
  const status = await ensureRunning(lane);
  const seeded = psql(lane, "select to_regnamespace('tests') is not null;").trim() === 't';
  if (!seeded) {
    info(
      'lane: the tests schema is missing (db:check leaves a database without seeds), so the database is reset first.'
    );
    await cmdReset(lane, []);
  }
  const vitest = path.join(ROOT, 'node_modules', '.bin', 'vitest');
  const result = spawnSync(vitest, ['run', '--config', 'tests/db/vitest.config.ts', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...laneEnv(lane, status) },
  });
  process.exit(result.status ?? 1);
}

function cmdCheck(lane) {
  const result = spawnSync('bash', [path.join(ROOT, 'scripts', 'check-migrations.sh')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, LANE: lane },
  });
  process.exit(result.status ?? 1);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

function mergeBase() {
  const base = git(['merge-base', 'HEAD', 'main']);
  return base ? base.trim() : null;
}

function cmdLintMigrations(args) {
  const defaultDir = path.join(ROOT, 'supabase', 'migrations');
  const dir = path.resolve(ROOT, args[0] ?? defaultDir);
  const problems = lintMigrationFiles(dir);
  const checked = existsSync(dir) ? readdirSync(dir).filter((f) => f !== '.gitkeep').length : 0;
  if (dir === defaultDir) {
    const base = mergeBase();
    if (base) {
      problems.push(
        ...forwardOnlyProblems(
          git(['diff', '--name-status', base, '--', 'supabase/migrations']) ?? ''
        )
      );
    } else {
      info(
        'migration rules: forward-only check skipped (there is no local main branch to compare with).'
      );
    }
  }
  info(`migration rules (S9): ${checked} file(s) checked, ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem.file}: ${problem.message}`);
  process.exit(problems.length ? 1 : 0);
}

async function cmdFingerprint(lane) {
  assertDocker();
  if (!isRunning(lane)) die(`lane ${lane} is not running (LANE=${lane} npm run db:start)`);
  const dump = spawnSync(
    'docker',
    [
      'exec',
      dbContainer(lane),
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '--schema-only',
      '--restrict-key=jv',
    ],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
  );
  if (dump.status !== 0) die(`pg_dump failed: ${dump.stderr}`);
  const extras = psql(lane, FINGERPRINT_EXTRAS_SQL);
  process.stdout.write(`${dump.stdout}\n-- extras that a schema dump does not hold\n${extras}`);
}

function cmdAdvisors(lane) {
  const result = supabase(lane, [
    'db',
    'advisors',
    '--local',
    '--level',
    'warn',
    '--fail-on',
    'warn',
  ]);
  process.exit(result.status ?? 1);
}

function cmdLintChanged() {
  const base = mergeBase() ?? 'HEAD';
  const changed = (git(['diff', '--name-only', '--diff-filter=ACMR', base]) ?? '')
    .split('\n')
    .filter(Boolean);
  const untracked = (git(['ls-files', '--others', '--exclude-standard']) ?? '')
    .split('\n')
    .filter(Boolean);
  const files = lintTargets([...new Set([...changed, ...untracked])], (file) =>
    existsSync(path.join(ROOT, file))
  );
  if (files.length === 0) {
    info('lint: no changed source files since the merge base with main');
    return;
  }
  info(`lint: ${files.length} changed file(s) since the merge base with main`);
  const eslint = path.join(ROOT, 'node_modules', '.bin', 'eslint');
  const result = spawnSync(eslint, ['--no-warn-ignored', ...files], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

async function cmdPorts() {
  info('lane  project   api    db     dev    state');
  for (const lane of LANES) {
    const ports = lanePorts(lane);
    let state;
    if (isRunning(lane)) state = 'running';
    else
      state =
        (await isPortFree(ports.api)) && (await isPortFree(ports.db)) ? 'free' : 'PORT IN USE';
    info(
      `${lane.padEnd(5)} ${projectId(lane).padEnd(9)} ${ports.api}  ${ports.db}  ${devPort(lane)}   ${state}`
    );
  }
}

function cmdStatus(lane) {
  assertDocker();
  const running = isRunning(lane);
  const ports = lanePorts(lane);
  info(`lane ${lane} (${projectId(lane)}): ${running ? 'running' : 'stopped'}`);
  info(`ports: api ${ports.api}, db ${ports.db}, dev server ${devPort(lane)}`);
  info(`docker volumes on this machine: ${volumeCount()}`);
}

async function cmdEnv(lane) {
  const status = readStatus(lane);
  if (!status) die(`lane ${lane} is not running (LANE=${lane} npm run db:start)`);
  process.stdout.write(renderEnvLocal(lane, status));
}

async function cmdRun(lane, args) {
  if (args.length === 0) die('usage: LANE=a npm run lane -- run <command> [args]');
  const status = await ensureRunning(lane);
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...laneEnv(lane, status) },
  });
  process.exit(result.status ?? 1);
}

function cmdPsql(lane, args) {
  assertDocker();
  if (!isRunning(lane)) die(`lane ${lane} is not running (LANE=${lane} npm run db:start)`);
  const tty = process.stdin.isTTY ? ['-it'] : ['-i'];
  const result = spawnSync(
    'docker',
    ['exec', ...tty, dbContainer(lane), 'psql', '-U', 'postgres', '-d', 'postgres', ...args],
    { stdio: 'inherit' }
  );
  process.exit(result.status ?? 1);
}

// ------------------------------------------------------------------------------------------------ verify

function runLogged(command, args, logFile, env) {
  return new Promise((resolve) => {
    const log = createWriteStream(logFile, { flags: 'a' });
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on('close', (code) => {
      log.end();
      resolve(code ?? 1);
    });
  });
}

async function cmdVerify(lane) {
  assertDocker();
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const plan = planVerify(scripts);
  const logDir = path.join(laneDir(lane), 'logs');
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const logFile = path.join(logDir, `verify-${stamp}.log`);
  const volumesBefore = volumeCount();
  /** @type {Array<{ name: string, status: 'passed' | 'FAILED' | 'skipped', detail: string }>} */
  const results = [];
  for (const step of plan) {
    if (step.skip) {
      info(`\n== ${step.name}: ${step.skip}`);
      results.push({
        name: step.name,
        status: 'skipped',
        detail: `task ${step.task}`,
      });
      continue;
    }
    info(`\n== ${step.name}`);
    if (step.needsLane) await ensureRunning(lane);
    const started = Date.now();
    const code = await runLogged('npm', ['run', step.script], logFile, {
      ...process.env,
      LANE: lane,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push(
      code === 0
        ? { name: step.name, status: 'passed', detail: `${seconds} s` }
        : { name: step.name, status: 'FAILED', detail: `${seconds} s, exit ${code}` }
    );
  }
  info(`\nverify, lane ${lane}`);
  for (const r of results) info(`  ${r.name.padEnd(22)} ${r.status} (${r.detail})`);
  const failed = results.filter((r) => r.status === 'FAILED');
  const skipped = results.filter((r) => r.status === 'skipped');
  info(`  docker volumes: ${volumesBefore} before, ${volumeCount()} after`);
  info(`  full output: ${path.relative(ROOT, logFile)}`);
  if (skipped.length) {
    info(`  skipped: ${skipped.map((r) => `${r.name} ${r.detail}`).join(', ')}`);
  }
  info(failed.length ? `verify FAILED: ${failed.map((r) => r.name).join(', ')}` : 'verify passed');
  process.exit(failed.length ? 1 : 0);
}

// ------------------------------------------------------------------------------------------------ entry

const HELP = `usage: LANE=<main|a|b|c> node scripts/lane.mjs <command> [options]

  start                  start the lane's stack (idempotent)
  stop [--no-backup]     stop it; --no-backup also deletes its Docker volumes
  status                 running or stopped, ports, Docker volume count
  reset [--no-seed]      empty database, migrations, seeds
  test [files]           reset, then pgTAP (supabase test db)
  test2 [vitest args]    Vitest over two connections and HTTP (tests/db)
  check                  T-F04: migrations twice give the same schema, advisor clean
  verify                 every gate (typecheck, lint, unit, db:check, db:test, db:test:2, build, ...)
  run <command...>       run a command with the lane's environment (PORT, DATABASE_URL, ...)
  psql [args]            psql inside the lane's database container
  env                    print the lane's .env.local
  fingerprint            print the schema fingerprint that check compares
  advisors               the Supabase advisor, failing on warnings
  ports                  the port plan of all four lanes (needs no LANE)
  lint-migrations [dir]  the file rules of S9 (needs no LANE)
  lint-changed           ESLint on the files changed since the merge base with main (needs no LANE)
`;

const NEEDS_NO_LANE = new Set(['ports', 'lint-migrations', 'lint-changed', 'help', undefined]);

/** @param {string[]} argv */
export async function main(argv) {
  const [command, ...args] = argv;
  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'ports') return cmdPorts();
  if (command === 'lint-migrations') return cmdLintMigrations(args);
  if (command === 'lint-changed') return cmdLintChanged();
  if (NEEDS_NO_LANE.has(command)) return undefined;
  let lane;
  try {
    lane = assertLane(process.env.LANE);
  } catch (error) {
    die(error.message);
  }
  switch (command) {
    case 'start':
      return cmdStart(lane);
    case 'stop':
      return cmdStop(lane, args);
    case 'status':
      return cmdStatus(lane);
    case 'reset':
      return cmdReset(lane, args);
    case 'test':
      return cmdTestPgTap(lane, args);
    case 'test2':
      return cmdTestTwoConnections(lane, args);
    case 'check':
      return cmdCheck(lane);
    case 'verify':
      return cmdVerify(lane);
    case 'run':
      return cmdRun(lane, args);
    case 'psql':
      return cmdPsql(lane, args);
    case 'env':
      return cmdEnv(lane);
    case 'fingerprint':
      return cmdFingerprint(lane);
    case 'advisors':
      return cmdAdvisors(lane);
    default:
      die(`unknown command "${command}". Try: node scripts/lane.mjs help`);
  }
  return undefined;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => die(error.message));
}
