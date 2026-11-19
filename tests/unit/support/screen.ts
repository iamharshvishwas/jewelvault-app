// Helpers to look at the screens of People & Roles in a test (plan: access and roles, Tasks 23 and 24). There is no DOM here, so a screen is drawn to markup on the server side of React and read
// as text, and the glue that a drawing cannot reach (what is handed on to what, which call sits under which check) is read from the syntax tree of the component's file:
//
//   draw(Component, props)                  the markup of a component, drawn once
//   plain(html)                             the words of a piece of markup, with the entities of React's output turned back
//   buttonsOf(html), optionsOf(html), chosenOf(html)    the words of the buttons, of the options of the drop-down lists, and of the options that are chosen
//   elementsOf('PeopleTab.tsx', 'AddPersonDialog')      the attributes (name -> the text of the value) of every JSX element with that tag in a file of components/
//   callsOf('ChangeSteps.tsx', 'runChange')             the text of the arguments of every call of that function in a file of components/
//   conditionsAround('RolesTab.tsx', 'onEdit')          for every call of that function, the conditions of the `if` statements it sits under
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

/** What a screen shows of a piece of markup: the words, with the entities of React's output turned back. */
export const plain = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

export const draw = (component: unknown, props: object) =>
  renderToStaticMarkup(createElement(component as never, props as never));

export const buttonsOf = (html: string) =>
  [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

/** The words of the options of the drop-down lists, and of those of them that are chosen. */
export const optionsOf = (html: string) =>
  [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
export const chosenOf = (html: string) =>
  [...html.matchAll(/<option[^>]*selected[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);

const COMPONENTS = path.resolve(__dirname, '../../../src/app/people-roles/components');

const treeOf = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(path.join(COMPONENTS, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

/** The attributes (name -> the text of the value) of every JSX element with this tag in a file. */
export function elementsOf(file: string, tag: string): Array<Record<string, string>> {
  const source = treeOf(file);
  const found: Array<Record<string, string>> = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(source) === tag
    ) {
      const attributes: Record<string, string> = {};
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const value = attribute.initializer;
        attributes[attribute.name.getText(source)] =
          value && ts.isJsxExpression(value) ? (value.expression?.getText(source) ?? '') : '';
      }
      found.push(attributes);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The text of the arguments of every call of a function with this name in a file. */
export function callsOf(file: string, callee: string): string[][] {
  const source = treeOf(file);
  const found: string[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === callee)
      found.push(node.arguments.map((argument) => argument.getText(source)));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** For every call of a function with this name in a file: the conditions of the `if` statements the call is in the "then" part of (the nearest first). */
export function conditionsAround(file: string, callee: string): string[][] {
  const source = treeOf(file);
  const found: string[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === callee) {
      const conditions: string[] = [];
      for (let child: ts.Node = node, up = node.parent; up; child = up, up = up.parent)
        if (ts.isIfStatement(up) && up.thenStatement === child)
          conditions.push(up.expression.getText(source));
      found.push(conditions);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
