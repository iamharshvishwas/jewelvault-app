// A tripwire for the files of a screen that holds a password (plan: access and roles, Tasks 22 and 23): it walks every source file under a folder and reports what could let a password out
// of the page. It is a tripwire, not a proof: it looks at what is written, so each rule has a control in the tests that use it (the checker sees the leak, and leaves harmless code alone).
//   - a console call or any other way out of the page: a use of `fetch`, an XMLHttpRequest, a socket, a beacon, a message to another window, the address bar, the history, the router, a
//     cookie, a pop-up box. The screen of People & Roles has no business with any of them: the API client is the one place that talks to the server;
//   - browser storage;
//   - a template or a sum of texts that holds something that names a password (an address, a message), a throw or an Error made from such a thing;
//   - the names: by default a word of the password (`password`, so also `temporary_password` and `typedPassword`) or `typed`; a caller may pass its own. A variable that is made from
//     something with such a name (`const shown = temporary.password`, `const { password: kept } = state`) has that name from then on, so a rename does not hide it.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Every .ts and .tsx under a folder, found by walking it (a file added next week is looked at at once). */
export function sourcesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** What the guards of every screen with a password look for by default. */
export const PASSWORD_NAMES = /password|typed/i;

const STORAGE = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'openDatabase']);
/** Ways out of the page (the console and `fetch` have kinds of their own below). */
const CHANNELS = new Set([
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'postMessage',
  'history',
  'location',
  'router',
  'useRouter',
  'cookie',
  'alert',
  'prompt',
]);

/** What a source text does that could let a password out; each line starts with its kind: console, fetch, storage, channel, template, sum, throw, error. */
export function leaksOf(text: string, name: string, names: RegExp = PASSWORD_NAMES): string[] {
  const source = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const aliases = new Set<string>();
  const isLiteral = (node: ts.Node) => ts.isStringLiteralLike(node) || ts.isTemplateLiteral(node);
  /** Does this tree name a password: by its words, or through a name that was made from one? Texts inside quotes do not count here. */
  const holds = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return names.test(node.text) || aliases.has(node.text);
    if (ts.isStringLiteralLike(node)) return false;
    return ts.forEachChild(node, (child) => (holds(child) ? true : undefined)) === true;
  };

  // names made from a password, found until nothing new turns up (a chain of two renames is found too)
  for (let round = 0; round < 4; round += 1) {
    const before = aliases.size;
    const learn = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        !isLiteral(node.initializer) &&
        !ts.isArrowFunction(node.initializer) &&
        !ts.isFunctionExpression(node.initializer) &&
        holds(node.initializer)
      )
        aliases.add(node.name.text);
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        (node.propertyName ?? node.name).getText(source).match(names)
      )
        aliases.add(node.name.text);
      ts.forEachChild(node, learn);
    };
    learn(source);
    if (aliases.size === before) break;
  }

  const found: string[] = [];
  const named = (node: ts.Node) => names.test(node.getText(source)) || holds(node);
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      if (node.text === 'console') found.push(`console: ${node.parent.getText(source)}`);
      else if (node.text === 'fetch') found.push(`fetch: ${node.parent.getText(source)}`);
      else if (STORAGE.has(node.text)) found.push(`storage: ${node.text}`);
      else if (CHANNELS.has(node.text)) found.push(`channel: ${node.parent.getText(source)}`);
    }
    if (ts.isTemplateExpression(node) && node.templateSpans.some((span) => named(span.expression)))
      found.push(`template: ${node.getText(source)}`);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (named(node.left) || named(node.right)) &&
      (ts.isStringLiteralLike(node.left) || ts.isStringLiteralLike(node.right))
    )
      found.push(`sum: ${node.getText(source)}`);
    if (ts.isThrowStatement(node) && named(node)) found.push(`throw: ${node.getText(source)}`);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /Error$/.test(node.expression.text) &&
      named(node)
    )
      found.push(`error: ${node.getText(source)}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
