import { toId, storyNameFromExport } from 'storybook/internal/csf';
import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { StoryBinding } from './catalog-coverage';
export async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) result.push(...await sourceFiles(path)); else result.push(path);
  }
  return result;
}
const unwrap = (node: ts.Expression): ts.Expression => ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
function property(node: ts.Expression | undefined, key: string): ts.Expression | undefined {
  if (!node) return;
  const object = unwrap(node); if (!ts.isObjectLiteralExpression(object)) return;
  const value = object.properties.find(item => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === key);
  return value && ts.isPropertyAssignment(value) ? value.initializer : undefined;
}
const literal = (node: ts.Expression | undefined) => node && ts.isStringLiteral(node) ? node.text : undefined;
function strings(node: ts.Expression | undefined): string[] {
  if (!node) return [];
  const array = unwrap(node); if (!ts.isArrayLiteralExpression(array)) throw new Error('Catalog metadata must contain explicit string arrays.');
  return array.elements.map(value => { const result = literal(value); if (!result) throw new Error('Catalog metadata must contain literal IDs.'); return result; });
}
function callable(node: ts.Expression | undefined, definitions: Map<string, ts.Expression>): boolean {
  if (!node) return false;
  const value = unwrap(node);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
  if (ts.isIdentifier(value)) return value.text !== 'undefined' && (definitions.has(value.text) ? callable(definitions.get(value.text), definitions) : true);
  // Imported play factories are checked again against the actual browser runtime manifest.
  return ts.isCallExpression(value);
}
export async function readStoryBindings(root: string): Promise<StoryBinding[]> {
  const results: StoryBinding[] = [];
  for (const path of (await sourceFiles(join(root, 'dev/stories'))).filter(path => path.endsWith('.stories.tsx'))) {
    const file = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const definitions = new Map<string, ts.Expression>();
    for (const statement of file.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) definitions.set(declaration.name.text, declaration.initializer);
    let meta: ts.Expression | undefined;
    for (const statement of file.statements) if (ts.isExportAssignment(statement)) meta = ts.isIdentifier(statement.expression) ? definitions.get(statement.expression.text) : statement.expression;
    const title = literal(property(meta, 'title')); if (!title) throw new Error(`Missing literal Storybook title: ${relative(root,path)}`);
    for (const statement of file.statements) if (ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const expression = ts.isIdentifier(declaration.initializer) ? definitions.get(declaration.initializer.text) : declaration.initializer;
      if (!expression) continue;
      const metadata = property(property(expression, 'parameters'), 'catalog');
      results.push({ file: relative(root,path), id: toId(title, storyNameFromExport(declaration.name.text)), title, name: literal(property(expression,'name')) ?? storyNameFromExport(declaration.name.text), states: strings(property(metadata,'states')), transitions: strings(property(metadata,'transitions')), interaction: callable(property(expression,'play'),definitions), sheet: declaration.name.text === 'StateSheet' || property(metadata,'sheet')?.kind === ts.SyntaxKind.TrueKeyword });
    }
  }
  return results;
}

export async function catalogFingerprint(root: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }));
  const files = (await Promise.all(['src','dev','.storybook','tests','scripts','docs'].map(folder => sourceFiles(join(root,folder))))).flat();
  files.push(...['package.json','pnpm-lock.yaml','tsconfig.json','vitest.storybook.config.ts','playwright.storybook.config.ts','README.md','PRD.md'].map(file => join(root,file)));
  for (const path of files.sort()) { hash.update(relative(root,path)); hash.update(await readFile(path)); }
  return hash.digest('hex');
}
