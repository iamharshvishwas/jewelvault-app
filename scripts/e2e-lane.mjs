#!/usr/bin/env node
// The end-to-end lane (task WEB00): a throw-away MariaDB, the built API and three test users, for the Playwright tests of the site.
//
//   LANE=b JV_API_DIR=<checkout of jewelvault-api> npm run e2e:lane -- up      start the lane (what Playwright's global setup does before the tests)
//   LANE=b npm run e2e:lane -- down                                           stop the API and remove the lane's container (docker rm -fv: no volume is left)
//   LANE=b npm run e2e:lane -- status                                         is the container up, is the API answering
//   npm run e2e:lane -- ports                                                 the ports of the four lanes
//
// `up` does, in order:
//   1. the API repository's own lane tool: `npm run db:lane -- up <lane>` (container jv-mariadb-<lane>, MariaDB 11.8, data in tmpfs, the ten-box user, migrations and seeds);
//      a container that already exists is emptied and migrated again (`reset`), so every run starts on a clean database;
//   2. compiles the API from JV_API_DIR (tsconfig.build.json) into node_modules/.cache/jv-e2e/<lane>/dist of THAT checkout (git ignores it), so two lanes never delete each other's build;
//   3. starts it on the lane's API port with a made-up admin token (its SHA-256 goes into JV_ADMIN_TOKEN_HASH), ALLOWED_ORIGINS set to the site's origin and the lane database's own password
//      (read from Docker in memory; it is never printed or written);
//   4. makes an owner, a biller and a staff user through the admin door with the API's real command (`npm run admin -- add-user`), signs each in once with the temporary password and changes it
//      (the must-change gate of U11), so the test users are ordinary users;
//   5. writes their e-mail addresses and passwords, and the token, to .lanes/<lane>/.env.local (mode 0600, git-ignored, rewritten on every run). Nothing secret goes anywhere else.
// `down` is safe to repeat. If `up` fails half way it takes down what it started.
//
// PORTS. The site (the Next.js dev server of Playwright's webServer) listens on PORT, else on the lane's port (main 4028, a 4128, b 4228, c 4328), else 4028; the API on that port + 1.
// JV_LANE_NAMESPACE and JV_LANE_PORT_BASE are passed on to the API repository's lane tool (its sandbox, container jv-mariadb-<namespace>-<lane>), for a second lane that must not touch a real one.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANES, assertLane, devPort, lanePorts } from './e2e-ports.cjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------------------------------------ lanes and ports

export { LANES, assertLane, devPort, lanePorts };

/** @param {number} port */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

// ------------------------------------------------------------------------------------------------ the API checkout

/**
 * JV_API_DIR: the checkout of jewelvault-api whose `main` the orchestrator keeps merged. Read-only for this tool except for the build folder below.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveApiDir(env = process.env) {
  const given = (env.JV_API_DIR ?? '').trim();
  if (given === '') {
    throw new Error(
      'JV_API_DIR is not set. Point it at a checkout of jewelvault-api, for example: JV_API_DIR=../jewelvault-api LANE=b E2E=1 npm run verify'
    );
  }
  const dir = path.resolve(given);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`JV_API_DIR (${dir}) does not exist or is not a folder.`);
  }
  let name;
  try {
    name = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
  } catch {
    name = undefined;
  }
  const tools = ['lane.mjs', 'admin.mjs'].every((file) =>
    existsSync(path.join(dir, 'scripts', file))
  );
  if (name !== 'jewelvault-api' || !tools) {
    throw new Error(
      `JV_API_DIR (${dir}) is not a checkout of jewelvault-api (a package.json named jewelvault-api with scripts/lane.mjs and scripts/admin.mjs).`
    );
  }
  return dir;
}

/**
 * Where this lane's compiled API lives: inside the checkout's node_modules/.cache (so the compiled files still find node_modules, and git ignores it), one folder per lane.
 * @param {string} apiDir
 * @param {string} lane
 */
export const apiBuildDir = (apiDir, lane) =>
  path.join(apiDir, 'node_modules', '.cache', 'jv-e2e', lane, 'dist');

/**
 * True when a `ps` command line is the API process of this lane (and so safe to stop).
 * @param {string} commandLine
 * @param {string} lane
 */
export const isLaneApiCommand = (commandLine, lane) =>
  commandLine.includes(path.join('node_modules', '.cache', 'jv-e2e', lane, 'dist', 'server.js'));

const KEPT_FROM_SHELL = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];

/**
 * The whole environment of the API process: the program path, the variables the API requires (spec A3, A12, U3) and nothing else from the shell.
 * @param {{ base: Record<string, string | undefined>, db: { host: string, port: number, name: string, user: string, password: string }, apiPort: number, webOrigin: string, adminTokenHash: string }} input
 * @returns {Record<string, string>}
 */
export function apiProcessEnv({ base, db, apiPort, webOrigin, adminTokenHash }) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of KEPT_FROM_SHELL) if (base[name] !== undefined) env[name] = String(base[name]);
  return {
    ...env,
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_NAME: db.name,
    DB_USER: db.user,
    DB_PASSWORD: db.password,
    ALLOWED_ORIGINS: webOrigin,
    JV_ADMIN_TOKEN_HASH: adminTokenHash,
    PORT: String(apiPort),
    LOG_LEVEL: 'info',
  };
}

// ------------------------------------------------------------------------------------------------ the admin door

/** The SHA-256 of a token's text in hex: what the API holds in JV_ADMIN_TOKEN_HASH (scripts/make-token.mjs of the API does the same). @param {string} token */
export const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
/** A new admin token: 32 random bytes, 43 characters of base64url, like `npm run make-token`. */
export const newToken = () => randomBytes(32).toString('base64url');
/** A password for a test user: 18 random bytes, 24 characters of base64url. */
export const newPassword = () => randomBytes(18).toString('base64url');
/**
 * @param {string} role
 * @param {string} run
 */
export const testEmail = (role, run) => `e2e-${role}-${run}@jv-test.local`;

/**
 * What the admin command reads from its input for `add-user`: the token (typed without echo in real life), the e-mail, the name and the role.
 * @param {string} token
 * @param {{ email: string, fullName: string, role: string }} user
 */
export const addUserInput = (token, user) =>
  `${token}\n${user.email}\n${user.fullName}\n${user.role}\n`;

/**
 * The temporary password in the command's output ("Temporary password (shown only now, write it down): ..."), or null.
 * @param {string} output
 * @returns {string | null}
 */
export function parseTemporaryPassword(output) {
  const found = /^Temporary password \(shown only now, write it down\): (\S+)\s*$/m.exec(output);
  return found ? found[1] : null;
}

// ------------------------------------------------------------------------------------------------ the lane's env file

export const ENV_MARKER =
  '# Written by scripts/e2e-lane.mjs. Holds the test logins and the test admin token of this lane. Local only, never committed; the next run rewrites it and `down` deletes it.';

/**
 * @param {string} lane
 * @param {string} [root]
 */
export const laneDir = (lane, root = ROOT) => path.join(root, '.lanes', assertLane(lane));

/**
 * The text of a lane env file. A name must be an upper-case variable name and a value must be one line: nothing can add a line of its own.
 * @param {Record<string, string>} values
 */
export function renderLaneEnv(values) {
  const lines = [ENV_MARKER];
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name))
      throw new Error(`env file: "${name}" is not a variable name`);
    if (/[\r\n]/.test(value)) throw new Error(`env file: the value of ${name} has a line break`);
    lines.push(`${name}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseLaneEnv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

/**
 * Writes .lanes/<lane>/.env.local, readable by its owner only. Returns the path.
 * @param {string} lane
 * @param {Record<string, string>} values
 * @param {{ root?: string }} [options]
 */
export function writeLaneEnv(lane, values, { root = ROOT } = {}) {
  const dir = laneDir(lane, root);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.env.local');
  writeFileSync(file, renderLaneEnv(values), { mode: 0o600 });
  chmodSync(file, 0o600); // the mode of writeFileSync only counts for a new file
  return file;
}

/**
 * @param {string} lane
 * @param {{ root?: string }} [options]
 * @returns {Record<string, string>}
 */
export function readLaneEnv(lane, { root = ROOT } = {}) {
  const file = path.join(laneDir(lane, root), '.env.local');
  if (!existsSync(file))
    throw new Error(`lane ${lane} is not up: ${path.relative(root, file)} does not exist`);
  return parseLaneEnv(readFileSync(file, 'utf8'));
}

// ------------------------------------------------------------------------------------------------ running things

const info = (message) => console.info(`e2e lane: ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertDocker() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0)
    throw new Error('Docker is not running. Start Docker Desktop first.');
}

/** The last lines of a log file, for an error message (the logs hold no secret: the API redacts, the lane tool prints no password). */
function tail(file, lines = 15) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/**
 * Runs a program to the end, its output going to a log file. Resolves with the exit code.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined>, logFile: string }} options
 */
function runLogged(command, args, { cwd, env, logFile }) {
  return new Promise((resolve, reject) => {
    const fd = openSync(logFile, 'a');
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd] });
    child.once('error', (error) => {
      closeSync(fd);
      reject(error);
    });
    child.once('close', (code) => {
      closeSync(fd);
      resolve(code ?? 1);
    });
  });
}

/** The API repository's lane tool: `npm run db:lane -- <command> <lane>`. */
async function dbLane(apiDir, command, lane, env, logFile) {
  const code = await runLogged('npm', ['run', '--silent', 'db:lane', '--', command, lane], {
    cwd: apiDir,
    env,
    logFile,
  });
  if (code !== 0)
    throw new Error(
      `npm run db:lane -- ${command} ${lane} failed (exit ${code}):\n${tail(logFile)}`
    );
}

const dbOptions = (env) => ({
  namespace: env.JV_LANE_NAMESPACE ?? '',
  portBase: Number(env.JV_LANE_PORT_BASE ?? 33310),
});

async function apiLaneTool(apiDir) {
  return import(pathToFileURL(path.join(apiDir, 'scripts', 'lane.mjs')).href);
}

/** @param {string} lane */
const pidFile = (lane) => path.join(laneDir(lane), 'api.pid');

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops the API process of this lane, if the pid file names a live process that is that API (never another program). Returns whether it stopped one. */
async function stopApi(lane) {
  const file = pidFile(lane);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, 'utf8').trim());
  rmSync(file, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return false;
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (!isLaneApiCommand(ps.stdout ?? '', lane)) {
    info(`process ${pid} is not this lane's API any more; left alone`);
    return false;
  }
  process.kill(pid, 'SIGTERM'); // the API closes its listener, waits for running calls (10 s at most) and exits
  for (let waited = 0; waited < 12_000 && isAlive(pid); waited += 100) await sleep(100);
  if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  return true;
}

/**
 * One call to the lane's API the way the site makes it: the site's Origin and X-JV-Client on every call.
 * @returns {Promise<{ status: number, json: any, cookie: string | null }>}
 */
async function apiCall(ports, method, pathName, { body, cookie } = {}) {
  /** @type {Record<string, string>} */
  const headers = { origin: ports.webOrigin, 'x-jv-client': 'web' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${ports.apiOrigin}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const setCookie = response.headers.getSetCookie?.()[0];
  return { status: response.status, json, cookie: setCookie ? setCookie.split(';')[0] : null };
}

async function waitForReady(ports, child, logFile) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`the API exited at start-up (code ${child.exitCode}):\n${tail(logFile)}`);
    try {
      const response = await fetch(`${ports.apiOrigin}/readyz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`the API did not answer /readyz within 40 s:\n${tail(logFile)}`);
}

/** `npm run admin -- add-user` against the lane's API: the real command of Harsh, fed through its input. Returns the temporary password. */
async function adminAddUser(apiDir, ports, token, user) {
  const env = {
    ...Object.fromEntries(
      KEPT_FROM_SHELL.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]])
    ),
    JV_API_URL: ports.apiOrigin,
  };
  const child = spawn('npm', ['--silent', 'run', 'admin', '--', 'add-user'], {
    cwd: apiDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (err += chunk));
  child.stdin.end(addUserInput(token, user));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (c) => resolve(c ?? 1));
  });
  const temporary = parseTemporaryPassword(out);
  if (code !== 0 || temporary === null) {
    // the command never prints the token; its output on success holds the temporary password, so only the error stream is shown
    throw new Error(
      `npm run admin -- add-user (${user.role}) failed (exit ${code}): ${err.trim().split('\n').slice(-3).join(' ')}`
    );
  }
  return temporary;
}

/** A made user signs in with the temporary password and changes it, so that the account is an ordinary one (U11); returns the new password. */
async function settlePassword(ports, user, temporary) {
  const login = await apiCall(ports, 'POST', '/v1/auth/login', {
    body: { email: user.email, password: temporary },
  });
  if (login.status !== 200 || !login.cookie)
    throw new Error(
      `the first login of the ${user.role} was refused: ${login.status} ${login.json?.error?.code ?? ''}`
    );
  const password = newPassword();
  const changed = await apiCall(ports, 'POST', '/v1/auth/change-password', {
    cookie: login.cookie,
    body: { current_password: temporary, new_password: password },
  });
  if (changed.status !== 200)
    throw new Error(
      `the ${user.role}'s password change was refused: ${changed.status} ${changed.json?.error?.code ?? ''} ${changed.json?.error?.details?.field ?? ''}`
    );
  await apiCall(ports, 'POST', '/v1/auth/logout', { cookie: login.cookie });
  return password;
}

export const TEST_ROLES = ['owner', 'biller', 'staff'];

// ------------------------------------------------------------------------------------------------ up, down, status

/**
 * Takes the lane down without waiting for anything: for a Ctrl-C or a kill while `laneUp` is still starting it (Playwright abandons a global setup that has not finished, so its
 * teardown never runs). Blocking on purpose: it runs in a signal handler, just before the process exits.
 * @param {string} lane
 * @param {Record<string, string | undefined>} env
 */
function emergencyDown(lane, env) {
  try {
    const file = pidFile(lane);
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8').trim());
      const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (Number.isInteger(pid) && pid > 1 && isLaneApiCommand(ps.stdout ?? '', lane))
        process.kill(pid, 'SIGKILL');
      rmSync(file, { force: true });
    }
    spawnSync('npm', ['run', '--silent', 'db:lane', '--', 'down', lane], {
      cwd: resolveApiDir(env),
      env,
      stdio: 'ignore',
    });
    rmSync(path.join(laneDir(lane), '.env.local'), { force: true });
  } catch (error) {
    info(`could not take the lane down: ${error.message}`);
  }
}

/**
 * Starts the lane. Resolves with { lane, ports, env, stop }; `env` is what was written to .lanes/<lane>/.env.local, `stop()` is `down`.
 * @param {string} lane
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export async function laneUp(lane, { env = process.env } = {}) {
  assertLane(lane);
  const ports = lanePorts({ ...env, LANE: lane });
  const apiDir = resolveApiDir(env);
  assertDocker();
  if (!existsSync(path.join(apiDir, 'node_modules', '@fastify', 'cors'))) {
    throw new Error(`the API's dependencies are not installed: run  npm ci  in ${apiDir}`);
  }
  const tsc = path.join(apiDir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc))
    throw new Error(`the API's dependencies are not installed: run  npm ci  in ${apiDir}`);

  // what an earlier, interrupted run of this lane left behind goes first
  await stopApi(lane);
  if (!(await isPortFree(ports.api))) {
    throw new Error(
      `port ${ports.api} (the API of lane ${lane}) is in use by another program. Free it, or choose another PORT.`
    );
  }

  const dir = laneDir(lane);
  const logs = path.join(dir, 'logs');
  mkdirSync(logs, { recursive: true });
  const dbLog = path.join(logs, 'db-lane.log');
  const buildLog = path.join(logs, 'api-build.log');
  const apiLog = path.join(logs, 'api.log');
  for (const file of [dbLog, buildLog, apiLog]) rmSync(file, { force: true });

  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    info(`${signal}: taking lane ${lane} down`);
    emergencyDown(lane, env);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const tool = await apiLaneTool(apiDir);
    const existed = (await tool.laneInfo(lane, dbOptions(env))) !== null;
    info(`${existed ? 'resetting' : 'starting'} the MariaDB container of lane ${lane}`);
    await dbLane(apiDir, existed ? 'reset' : 'up', lane, env, dbLog);
    const db = await tool.laneInfo(lane, dbOptions(env));
    if (db === null || !db.running)
      throw new Error(`the lane database of ${lane} is not running after db:lane`);

    info('compiling the API (tsc, tsconfig.build.json)');
    const out = apiBuildDir(apiDir, lane);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const built = await runLogged(
      process.execPath,
      [tsc, '-p', path.join(apiDir, 'tsconfig.build.json'), '--outDir', out],
      { cwd: apiDir, env: process.env, logFile: buildLog }
    );
    if (built !== 0)
      throw new Error(`the API did not compile (exit ${built}):\n${tail(buildLog, 25)}`);
    writeFileSync(path.join(out, 'package.json'), '{ "type": "module" }\n'); // the compiled files are ES modules; the nearest package.json is cut off at node_modules otherwise

    const token = newToken();
    info(`starting the API on ${ports.apiOrigin}`);
    const fd = openSync(apiLog, 'w');
    const child = spawn(process.execPath, [path.join(out, 'server.js')], {
      cwd: apiDir,
      env: apiProcessEnv({
        base: process.env,
        db: {
          host: db.host,
          port: db.port,
          name: db.database,
          user: db.appUser,
          password: db.appPassword,
        },
        apiPort: ports.api,
        webOrigin: ports.webOrigin,
        adminTokenHash: tokenHash(token),
      }),
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    child.unref();
    writeFileSync(pidFile(lane), `${child.pid}\n`);
    await waitForReady(ports, child, apiLog);

    info('making the owner, biller and staff users through the admin door');
    const run = randomBytes(4).toString('hex');
    /** @type {Record<string, string>} */
    const values = {
      JV_LANE: lane,
      PORT: String(ports.web),
      NEXT_PUBLIC_API_URL: ports.apiOrigin,
      JV_E2E_WEB_ORIGIN: ports.webOrigin,
      JV_E2E_API_URL: ports.apiOrigin,
      JV_E2E_ADMIN_TOKEN: token,
    };
    for (const role of TEST_ROLES) {
      const user = { email: testEmail(role, run), fullName: `Test ${role}`, role };
      const temporary = await adminAddUser(apiDir, ports, token, user);
      values[`JV_E2E_${role.toUpperCase()}_EMAIL`] = user.email;
      values[`JV_E2E_${role.toUpperCase()}_PASSWORD`] = await settlePassword(
        ports,
        user,
        temporary
      );
    }
    writeLaneEnv(lane, values);
    info(
      `lane ${lane} is up: site ${ports.webOrigin}, API ${ports.apiOrigin}, container ${db.name}, logins in ${path.relative(ROOT, path.join(dir, '.env.local'))}`
    );
    return { lane, ports, env: values, stop: () => laneDown(lane, { env }) };
  } catch (error) {
    await laneDown(lane, { env }).catch((downError) =>
      info(`could not take the lane down: ${downError.message}`)
    );
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/**
 * Stops the API and removes the lane's container (docker rm -fv, no volume), deletes the lane's env file. Safe to repeat.
 * @param {string} lane
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export async function laneDown(lane, { env = process.env } = {}) {
  assertLane(lane);
  const stopped = await stopApi(lane);
  const apiDir = resolveApiDir(env);
  mkdirSync(path.join(laneDir(lane), 'logs'), { recursive: true });
  await dbLane(apiDir, 'down', lane, env, path.join(laneDir(lane), 'logs', 'db-lane.log'));
  rmSync(path.join(laneDir(lane), '.env.local'), { force: true });
  info(
    `lane ${lane} is down${stopped ? ' (API stopped, container removed)' : ' (container removed)'}`
  );
}

async function laneStatus(lane, env) {
  const ports = lanePorts({ ...env, LANE: lane });
  const apiDir = resolveApiDir(env);
  const tool = await apiLaneTool(apiDir);
  const db = await tool.laneInfo(lane, dbOptions(env));
  let api = 'not answering';
  try {
    const response = await fetch(`${ports.apiOrigin}/readyz`, {
      signal: AbortSignal.timeout(2000),
    });
    api = `answers ${response.status}`;
  } catch {
    // stays "not answering"
  }
  info(
    `lane ${lane}: container ${db ? (db.running ? 'running' : 'stopped') : 'none'}, API ${ports.apiOrigin} ${api}, site port ${ports.web} ${(await isPortFree(ports.web)) ? 'free' : 'in use'}`
  );
}

// ------------------------------------------------------------------------------------------------ command line

const HELP = `usage: LANE=<main|a|b|c> JV_API_DIR=<jewelvault-api checkout> node scripts/e2e-lane.mjs <command>

  up        start the lane's MariaDB container and API, make the three test users, write .lanes/<lane>/.env.local
  down      stop the API and remove the container (docker rm -fv); safe to repeat
  status    container, API and site port
  ports     the site and API ports of the four lanes (needs no LANE)
`;

/** @param {string[]} argv */
export async function main(argv) {
  const [command] = argv;
  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'ports') {
    for (const lane of LANES) {
      const p = lanePorts({ LANE: lane });
      info(`${lane.padEnd(5)} site ${p.web}  API ${p.api}`);
    }
    return;
  }
  const lane = assertLane(process.env.LANE);
  if (command === 'up') {
    await laneUp(lane);
  } else if (command === 'down') {
    await laneDown(lane);
  } else if (command === 'status') {
    await laneStatus(lane, process.env);
  } else {
    throw new Error(`unknown command "${command}". Try: node scripts/e2e-lane.mjs help`);
  }
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`e2e lane: ${error.message}`);
    process.exit(1);
  });
}
