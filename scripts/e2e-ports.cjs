// The lane names and ports of the end-to-end tests (WEB00): the part of scripts/e2e-lane.mjs that Playwright's config has to load.
//
// It is a CommonJS file of its own on purpose. Playwright compiles the files that its TypeScript files import to CommonJS, and a compiled
// ES module cannot use `import.meta`, which e2e-lane.mjs needs; worse, a module that Playwright has loaded that way cannot be loaded again
// as an ES module by e2e-lane.mjs (the names are lost). A .cjs file is the same thing to both, and has no top-level work.
// scripts/e2e-lane.mjs re-exports everything here.
'use strict';

const LANES = ['main', 'a', 'b', 'c'];
const DEV_PORT_BASE = 4028; // the site of lane main; a is 4128, b 4228, c 4328 (the same plan as the old lane tool)
const DEV_PORT_STEP = 100;
const FIRST_DYNAMIC_PORT = 49152; // where the operating system starts handing out temporary ports
const FIRST_USABLE_PORT = 1024;

/**
 * The lane name, or an error that says what to type.
 * @param {string | undefined} name
 * @returns {string}
 */
function assertLane(name) {
  if (!name) {
    throw new Error(
      `LANE is not set. Pick one of ${LANES.join(', ')}, for example: LANE=b E2E=1 npm run verify`
    );
  }
  if (!LANES.includes(name)) {
    throw new Error(`Unknown lane "${name}". The lanes are ${LANES.join(', ')}.`);
  }
  return name;
}

/** @param {string} lane */
const devPort = (lane) => DEV_PORT_BASE + DEV_PORT_STEP * LANES.indexOf(assertLane(lane));

/**
 * The ports of a run: the site on PORT (else the lane's, else 4028), the API on the next one. Origins are written the way a browser sends them.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ lane: string | null, web: number, api: number, webOrigin: string, apiOrigin: string }}
 */
function lanePorts(env = process.env) {
  const laneName = (env.LANE ?? '').trim();
  const lane = laneName === '' ? null : assertLane(laneName);
  const portText = (env.PORT ?? '').trim();
  if (portText !== '' && !/^\d{1,5}$/.test(portText)) {
    throw new Error(
      `PORT must be a whole number between ${FIRST_USABLE_PORT} and ${FIRST_DYNAMIC_PORT - 2}.`
    );
  }
  const web = portText !== '' ? Number(portText) : lane ? devPort(lane) : DEV_PORT_BASE;
  const api = web + 1;
  if (web < FIRST_USABLE_PORT || api >= FIRST_DYNAMIC_PORT) {
    throw new Error(
      `PORT ${web} is outside ${FIRST_USABLE_PORT} to ${FIRST_DYNAMIC_PORT - 2} (the API takes the next port, and the system hands out ${FIRST_DYNAMIC_PORT} and above).`
    );
  }
  return {
    lane,
    web,
    api,
    webOrigin: `http://localhost:${web}`,
    apiOrigin: `http://localhost:${api}`,
  };
}

module.exports = { LANES, assertLane, devPort, lanePorts };
