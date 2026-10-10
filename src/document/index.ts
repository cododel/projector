import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkGfm from 'remark-gfm';
import {
  DocumentValidationError,
  isWidgetValueValid,
  type DocumentNode,
  type ParsedDocument,
  type WidgetDefinition,
  type WidgetKind,
} from './types';

export * from './types';

interface SyntaxNode {
  type: string;
  value?: unknown;
  children?: SyntaxNode[];
  name?: string | null;
  attributes?: Attribute[];
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  url?: string;
  title?: string | null;
  alt?: string;
  lang?: string | null;
  meta?: string | null;
  align?: Array<'left' | 'right' | 'center' | null>;
  identifier?: string;
  referenceType?: string;
}

interface Attribute {
  type: string;
  name?: string;
  value?: string | null | { type: string; value: string };
}

const processor = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
const markdownTypes = new Set([
  'paragraph',
  'text',
  'heading',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'code',
  'blockquote',
  'list',
  'listItem',
  'thematicBreak',
  'break',
  'link',
  'image',
  'table',
  'tableRow',
  'tableCell',
]);
const widgetKinds: Record<string, WidgetKind> = {
  Choice: 'choice',
  TextAnswer: 'text',
  Checklist: 'checklist',
};
const allowedComponents = new Set([...Object.keys(widgetKinds), 'Details', 'Callout']);

function fail(message: string): never {
  throw new DocumentValidationError(message);
}

function safeUrl(url: string): string {
  // Controls/escapes must not hide an executable URL scheme from the renderer.
  // Controls must be rejected at this security boundary.
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u0020\u007f\\]/u.test(url))
    fail('Links must use a safe absolute HTTP(S), mailto, or document anchor URL.');
  if (url.startsWith('#')) return url;
  if (/^mailto:[^:]+$/iu.test(url)) return url;
  if (!/^https?:\/\//iu.test(url)) fail(`Unsupported link URL: ${url}`);
  try {
    const parsed = new URL(url);
    if (!parsed.hostname || parsed.username || parsed.password)
      fail('Link URLs cannot contain credentials.');
  } catch {
    fail('Invalid link URL.');
  }
  return url;
}

function propsFrom(attributes: Attribute[] = []): Record<string, unknown> {
  const props: Record<string, unknown> = Object.create(null);
  for (const attribute of attributes) {
    if (attribute.type !== 'mdxJsxAttribute' || !attribute.name)
      fail('Spread attributes are not supported.');
    const name = attribute.name;
    if (
      /^on/iu.test(name) ||
      ['__proto__', 'prototype', 'constructor', 'style', 'dangerouslySetInnerHTML'].includes(name)
    ) {
      fail(`Unsafe component property: ${name}`);
    }
    if (Object.hasOwn(props, name)) fail(`Duplicate component property: ${name}`);
    if (typeof attribute.value === 'string') props[name] = attribute.value;
    else if (
      attribute.value &&
      typeof attribute.value === 'object' &&
      attribute.value.type === 'mdxJsxAttributeValueExpression'
    ) {
      try {
        props[name] = JSON.parse(attribute.value.value) as unknown;
      } catch {
        fail(`Property ${name} must contain literal JSON.`);
      }
    } else fail(`Property ${name} must contain a string or literal JSON value.`);
  }
  return props;
}

function requireString(props: Record<string, unknown>, key: string, limit = 2000): string {
  const value = props[key];
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    fail(`Property ${key} must be a non-empty string (maximum ${limit} characters).`);
  return value;
}

function checkProperties(props: Record<string, unknown>, names: string[]): void {
  for (const name of Object.keys(props))
    if (!names.includes(name)) fail(`Unsupported component property: ${name}`);
}

/** Parse constrained MDX without evaluating expressions, imports, or artifact code. */
export function parseDocument(source: string): ParsedDocument {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 2_000_000)
    fail('Document source must be at most 2 MB.');
  let root: SyntaxNode;
  try {
    // The AST comes from the fixed bundled parser, not an arbitrary artifact module.
    root = processor.parse(source) as SyntaxNode;
  } catch (error) {
    fail(`Invalid MDX: ${error instanceof Error ? error.message : 'parse error'}`);
  }
  const widgets: WidgetDefinition[] = [];
  const widgetIds = new Set<string>();
  const definitions = new Map<string, SyntaxNode>();
  for (const child of root.children ?? [])
    if (child.type === 'definition') definitions.set(child.identifier ?? '', child);
  let nodeNumber = 0;

  function convert(node: SyntaxNode, depth = 0): DocumentNode | null {
    if (++nodeNumber > 30_000 || depth > 100)
      fail('Document exceeds the supported structure limits.');
    if (node.type === 'definition') {
      safeUrl(node.url ?? '');
      return null;
    }
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const definition = definitions.get(node.identifier ?? '');
      if (!definition) fail('Link reference has no matching definition.');
      return convert(
        {
          ...node,
          type: node.type === 'linkReference' ? 'link' : 'image',
          url: definition.url,
          title: definition.title,
        },
        depth,
      );
    }
    const id = `block-${nodeNumber}`;
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      if (!node.name || !allowedComponents.has(node.name))
        fail(`Unsupported component: ${node.name ?? 'fragment'}`);
      const props = propsFrom(node.attributes);
      const kind = widgetKinds[node.name];
      if (kind) {
        checkProperties(props, ['id', 'meaning', 'semanticsVersion', 'options', 'defaultValue']);
        const widgetId = requireString(props, 'id', 80);
        if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(widgetId))
          fail(
            'Widget id must begin with a letter and contain letters, numbers, dots, underscores, or hyphens.',
          );
        if (widgetIds.has(widgetId)) fail(`Duplicate widget id: ${widgetId}`);
        if (
          node.children?.some(
            (child) =>
              child.type !== 'text' || typeof child.value !== 'string' || child.value.trim(),
          )
        )
          fail('Widgets cannot contain child content.');
        const meaning = requireString(props, 'meaning');
        const semanticsVersion = requireString(props, 'semanticsVersion', 100);
        let options: string[] | undefined;
        if (kind !== 'text') {
          const input = props.options;
          if (
            !Array.isArray(input) ||
            !input.length ||
            input.length > 200 ||
            input.some(
              (value) => typeof value !== 'string' || !value.trim() || value.length > 1000,
            ) ||
            new Set(input).size !== input.length
          ) {
            fail('Choice and Checklist options must be a non-empty array of unique strings.');
          }
          options = input as string[];
        } else if ('options' in props) fail('TextAnswer does not accept options.');
        const widget: WidgetDefinition = {
          id: widgetId,
          kind,
          meaning,
          semanticsVersion,
          ...(options ? { options } : {}),
          defaultValue: kind === 'checklist' ? [] : '',
          schemaFingerprint: JSON.stringify({ kind, options: options ?? null }),
        };
        if (
          !Object.hasOwn(props, 'defaultValue') ||
          !isWidgetValueValid(widget, props.defaultValue)
        )
          fail(`Invalid defaultValue for ${widgetId}.`);
        widget.defaultValue = props.defaultValue;
        widgetIds.add(widgetId);
        widgets.push(widget);
        return { type: 'widget', id, props: { widgetId } };
      }
      if (node.name === 'Details') {
        checkProperties(props, ['title']);
        requireString(props, 'title');
      } else {
        checkProperties(props, ['title', 'tone']);
        if ('title' in props) requireString(props, 'title');
        if ('tone' in props && !['info', 'warning', 'success'].includes(String(props.tone)))
          fail('Callout tone must be info, warning, or success.');
      }
      return {
        type: node.name === 'Details' ? 'details' : 'callout',
        id,
        props,
        children: childrenOf(node, depth),
      };
    }
    if (!markdownTypes.has(node.type))
      fail(
        `Unsupported MDX node: ${node.type}. Executable expressions and imports are not allowed.`,
      );
    const result: DocumentNode = { type: node.type, id };
    if (typeof node.value === 'string') result.value = node.value;
    if (node.children) result.children = childrenOf(node, depth);
    if (node.type === 'heading') result.props = { depth: node.depth };
    if (node.type === 'list') result.props = { ordered: !!node.ordered, start: node.start ?? 1 };
    if (node.type === 'listItem') result.props = { checked: node.checked ?? null };
    if (node.type === 'table') result.props = { align: node.align ?? [] };
    if (node.type === 'link' || node.type === 'image') {
      result.props = {
        url: safeUrl(node.url ?? ''),
        title: node.title ?? '',
        ...(node.type === 'image' ? { alt: node.alt ?? '' } : {}),
      };
    }
    if (node.type === 'code') {
      if (node.meta) fail('Code fence metadata is not supported.');
      const language = node.lang ?? '';
      if (
        language === 'mermaid' &&
        (/%%\s*\{/u.test(result.value ?? '') ||
          /(?:^|;)\s*click\s/imu.test(result.value ?? '') ||
          /^\s*---(?:\r?\n|$)/u.test(result.value ?? ''))
      )
        fail(
          'Mermaid directives, frontmatter configuration, and click handlers are not supported.',
        );
      result.props = { language };
    }
    return result;
  }

  function childrenOf(node: SyntaxNode, depth: number): DocumentNode[] {
    return (node.children ?? [])
      .map((child) => convert(child, depth + 1))
      .filter((child): child is DocumentNode => child !== null);
  }

  return { blocks: childrenOf(root, 0), widgets };
}
