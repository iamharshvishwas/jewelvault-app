// WEB03, spec C9: "Render-time reads and useState(getX()) stay valid because data is in memory after the gate; the 16 files that re-read the stores every
// second keep doing so only against memory, and none of them calls the network."
//
// The 16 are the screens that start a timer (setInterval) to read a store again; the stores they read are src/lib/designStore.ts, catalogStore.ts,
// settingsStore.ts, appStore.ts and orderStore.ts. This test reads their source with the TypeScript parser (comments do not count) and refuses a network
// call in any of them: a fetch, an XMLHttpRequest, a beacon, a socket, an import of the API client, the hydrate or the session store. The test that
// the timers cost no request in a browser is T-E02 of WEB04 (which will have a poller of its own).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

interface Findings {
  imports: string[];
  /** The names taken from each module (a type-only import has none). */
  names: Map<string, string[]>;
  calls: string[];
  timers: number;
}

/** What a source file imports, which names it calls, and how many timers it starts. */
function inspect(file: string): Findings {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: Findings = { imports: [], names: new Map(), calls: [], timers: 0 };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) {
        const specifier = node.moduleSpecifier.text;
        found.imports.push(specifier);
        const bindings = node.importClause?.namedBindings;
        const named =
          bindings && ts.isNamedImports(bindings)
            ? bindings.elements
                .filter((e) => !e.isTypeOnly)
                .map((e) => (e.propertyName ?? e.name).text)
            : [];
        found.names.set(specifier, [...(found.names.get(specifier) ?? []), ...named]);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      found.calls.push(name);
      if (name === 'setInterval') found.timers += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const NETWORK_CALLS = ['fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource'];
const NETWORK_MODULES = [/api\/client/, /cache\/hydrate/, /supabase/];
/** A screen may read the session from memory (the role); it may not take anything out of the session store that signs in, signs out or asks the server. */
const SESSION_READS = [
  'useSession',
  'getSessionState',
  'canAccessPath',
  'ROLE_LABEL',
  'initialsOf',
];

function expectMemoryOnly(file: string) {
  const found = inspect(file);
  for (const call of NETWORK_CALLS) expect(found.calls, call).not.toContain(call);
  for (const specifier of found.imports) {
    for (const pattern of NETWORK_MODULES) expect(specifier, specifier).not.toMatch(pattern);
  }
  const fromSession = found.imports.filter((m) => /authStore$/.test(m));
  for (const specifier of fromSession) {
    for (const name of found.names.get(specifier) ?? [])
      expect(SESSION_READS, name).toContain(name);
  }
}

const screens = [
  ...walk(path.join(root, 'src/app')),
  ...walk(path.join(root, 'src/components')),
].filter((file) => inspect(file).timers > 0);
const stores = ['designStore', 'catalogStore', 'settingsStore', 'appStore', 'orderStore'].map(
  (name) => path.join(root, 'src/lib', `${name}.ts`)
);

describe('C9 (T-E02 clause): the screens that re-read the stores every second read memory only', () => {
  it('there are 16 of them, as the spec counts', () => {
    expect(screens.map((file) => path.relative(root, file))).toHaveLength(16);
  });

  for (const file of screens) {
    it(`${path.relative(root, file)} makes no network call and imports nothing that makes one`, () => {
      expectMemoryOnly(file);
    });
  }

  for (const file of stores) {
    it(`${path.relative(root, file)} reads memory: no network call, no import of the client, the hydrate or the session`, () => {
      expectMemoryOnly(file);
      expect(inspect(file).imports.filter((m) => /authStore$/.test(m))).toEqual([]);
    });
  }

  it('the checker sees a fetch and a client import when there is one (negative control)', () => {
    const found = inspect(path.join(root, 'src/lib/cache/hydrate.ts'));
    expect(found.imports.some((m) => /api\/client/.test(m))).toBe(true);
    const client = inspect(path.join(root, 'src/lib/api/client.ts'));
    expect(client.calls).toContain('fetch');
  });
});
