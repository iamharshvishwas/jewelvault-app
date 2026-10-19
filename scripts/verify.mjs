#!/usr/bin/env node
// The gates before anything is called ready to push (WEB00), and the changed-file lint they use. They lived in the per-agent lane tool of the old database build; WEB15 deleted that
// tool with the rest of the old database pieces and kept these two commands here.
//
//   npm run verify                  typecheck, changed-file lint, unit tests, build, build check and, with E2E=1, the Playwright tests
//   LANE=a JV_API_DIR=<checkout of jewelvault-api> E2E=1 npm run verify
//                                   the same with the browser tests, on a lane (a MariaDB container, the API of JV_API_DIR and three test users: scripts/e2e-lane.mjs)
//   npm run lint:changed            ESLint on the files changed since the merge base with main (needs no lane)
//
// Only the e2e step needs a lane, so plain `npm run verify` needs neither LANE nor Docker.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const info = (message) => console.info(message);
function die(message) {
  console.error(`verify: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------------------------------------ the plan

const VERIFY_STEPS = [
  { name: 'typecheck', script: 'typecheck' },
  { name: 'lint (changed files)', script: 'lint:changed' },
  { name: 'unit', script: 'test' },
  { name: 'build', script: 'build' },
  { name: 'build check', script: 'check:build' },
  { name: 'e2e', script: 'test:e2e', needsLane: true },
];

/**
 * @param {Record<string, string>} scripts the scripts of package.json
 * @param {Record<string, string | undefined>} [env] the environment: E2E=1 switches the e2e step on
 * @returns {Array<{ name: string, script: string, needsLane: boolean, missing: boolean, skip?: string }>}
 */
export function planVerify(scripts, env = process.env) {
  return VERIFY_STEPS.map((step) => ({
    ...step,
    needsLane: Boolean(step.needsLane),
    missing: !scripts[step.script],
    skip: step.needsLane && env.E2E !== '1' ? 'skipped (set E2E=1 to run it)' : undefined,
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

// ------------------------------------------------------------------------------------------------ lint-changed

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

function mergeBase() {
  const base = git(['merge-base', 'HEAD', 'main']);
  return base ? base.trim() : null;
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

// ------------------------------------------------------------------------------------------------ verify

function assertDocker() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0)
    die('Docker is not running. Start Docker Desktop first.');
}

function volumeCount() {
  const result = spawnSync('docker', ['volume', 'ls', '-q'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean).length : -1;
}

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

/** Is the lane's MariaDB container still there? (`docker rm -fv` should have removed it.) */
function laneContainerLeft(lane) {
  const namespace = process.env.JV_LANE_NAMESPACE ? `${process.env.JV_LANE_NAMESPACE}-` : '';
  const result = spawnSync(
    'docker',
    ['ps', '-a', '-q', '--filter', `name=^jv-mariadb-${namespace}${lane}$`],
    { encoding: 'utf8' }
  );
  return result.status === 0 && result.stdout.trim() !== '';
}

async function cmdVerify() {
  const withE2e = process.env.E2E === '1';
  let lane = null;
  if (withE2e) {
    // Fail before the long steps, not after them: the e2e step needs a lane, the API checkout and Docker.
    try {
      // loaded only here: this file stays usable on its own
      const e2eLane = await import('./e2e-lane.mjs');
      lane = e2eLane.assertLane(process.env.LANE);
      e2eLane.resolveApiDir(process.env);
    } catch (error) {
      die(error.message);
    }
    assertDocker();
  }
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const plan = planVerify(scripts, process.env);
  const logDir = path.join(ROOT, '.lanes', lane ?? '_local', 'logs');
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const logFile = path.join(logDir, `verify-${stamp}.log`);
  const volumesBefore = withE2e ? volumeCount() : null;
  /** @type {Array<{ name: string, status: 'passed' | 'FAILED' | 'skipped', detail: string }>} */
  const results = [];
  for (const step of plan) {
    if (step.skip) {
      info(`\n== ${step.name}: ${step.skip}`);
      results.push({ name: step.name, status: 'skipped', detail: step.skip });
      continue;
    }
    info(`\n== ${step.name}`);
    if (step.missing) {
      results.push({
        name: step.name,
        status: 'FAILED',
        detail: `package.json has no script "${step.script}"`,
      });
      continue;
    }
    const started = Date.now();
    const code = await runLogged('npm', ['run', step.script], logFile, {
      ...process.env,
      ...(lane ? { LANE: lane } : {}),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push(
      code === 0
        ? { name: step.name, status: 'passed', detail: `${seconds} s` }
        : { name: step.name, status: 'FAILED', detail: `${seconds} s, exit ${code}` }
    );
  }
  info(`\nverify${lane ? `, lane ${lane}` : ''}`);
  for (const r of results) {
    const outcome = r.status === 'skipped' ? r.detail : `${r.status} (${r.detail})`;
    info(`  ${r.name.padEnd(22)} ${outcome}`);
  }
  const failed = results.filter((r) => r.status === 'FAILED');
  if (withE2e) {
    info(`  docker volumes: ${volumesBefore} before, ${volumeCount()} after`);
    info(`  lane container afterwards: ${laneContainerLeft(lane) ? 'STILL THERE' : 'none'}`);
  }
  info(`  full output: ${path.relative(ROOT, logFile)}`);
  info(failed.length ? `verify FAILED: ${failed.map((r) => r.name).join(', ')}` : 'verify passed');
  process.exit(failed.length ? 1 : 0);
}

// ------------------------------------------------------------------------------------------------ entry

const HELP = `usage: node scripts/verify.mjs <command>

  verify         every gate (typecheck, lint, unit, build, build check; E2E=1 adds the Playwright tests on a lane, see scripts/e2e-lane.mjs)
                 (needs no LANE without E2E=1)
  lint-changed   ESLint on the files changed since the merge base with main (needs no lane)
`;

/** @param {string[]} argv */
export async function main(argv) {
  const [command] = argv;
  if (command === 'verify') return cmdVerify();
  if (command === 'lint-changed') return cmdLintChanged();
  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(HELP);
    return undefined;
  }
  return die(`unknown command "${command}". Try: node scripts/verify.mjs help`);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => die(error.message));
}
