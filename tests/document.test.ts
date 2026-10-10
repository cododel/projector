import { describe, expect, it } from 'vitest';
import {
  areWidgetsCompatible,
  DocumentValidationError,
  isWidgetValueValid,
  parseDocument,
} from '../src/document';

const choice =
  '<Choice id="role" meaning="Default access level" semanticsVersion="1" options={["Viewer", "Editor"]} defaultValue="Viewer" />';

describe('constrained MDX authoring boundary', () => {
  it('produces serializable Markdown, diagram and declared widget data', () => {
    const result = parseDocument(
      `# Access contract\n\n| Role | Permission |\n| --- | --- |\n| Viewer | Read |\n\n${choice}\n\n<TextAnswer id="reason" meaning="Decision rationale" semanticsVersion="1" defaultValue="" />\n\n<Checklist id="checks" meaning="Required checks" semanticsVersion="1" options={["Audit", "Migration"]} defaultValue={["Audit"]} />\n\n<Details title="Acceptance details">\n\nConfirm the **least privilege** rule.\n\n</Details>\n\n<Callout tone="warning" title="Boundary">Approval does not authorize implementation.</Callout>\n\n\`\`\`mermaid\ngraph LR\nA-->B\n\`\`\``,
    );
    expect(result.widgets.map((widget) => [widget.id, widget.kind, widget.defaultValue])).toEqual([
      ['role', 'choice', 'Viewer'],
      ['reason', 'text', ''],
      ['checks', 'checklist', ['Audit']],
    ]);
    expect(result.blocks.map((block) => block.type)).toContain('table');
    expect(result.blocks.find((block) => block.type === 'code')?.props).toEqual({
      language: 'mermaid',
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it.each([
    'import Evil from "evil"\n\n# Plan',
    'export const secret = process.env',
    '{process.exit()}',
    '<script>alert(1)</script>',
    '<iframe src="https://example.com" />',
    '<Choice {...props} />',
    choice.replace('defaultValue="Viewer"', 'defaultValue={getDefault()}'),
    choice.replace('defaultValue="Viewer"', 'defaultValue="Viewer" onClick={() => alert(1)}'),
    '[run](javascript:alert%281%29)',
    '[file](file:///etc/passwd)',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '[credentials](https://secret@example.com)',
    '[run][evil]\n\n[evil]: javascript:alert%281%29',
    '```mermaid\n%%{init: {"securityLevel":"loose"}}%%\ngraph LR\nA-->B\n```',
    '```mermaid\ngraph LR\nclick A "javascript:alert(1)"\n```',
    '```mermaid\n---\nconfig:\n  securityLevel: loose\n---\ngraph LR\nA-->B\n```',
    '```mermaid\ngraph LR; click A "https://example.com";\n```',
  ])('rejects executable or unsafe input without evaluating it: %s', (source) => {
    expect(() => parseDocument(source)).toThrow(DocumentValidationError);
  });

  it.each([
    `${choice}\n\n${choice}`,
    choice.replace('meaning="Default access level"', 'meaning=""'),
    choice.replace('semanticsVersion="1"', ''),
    choice.replace('["Viewer", "Editor"]', '["Viewer", "Viewer"]'),
    choice.replace('defaultValue="Viewer"', 'defaultValue="Admin"'),
    '<Checklist id="checks" meaning="Checks" semanticsVersion="1" options={["One"]} defaultValue={["One", "One"]} />',
    '<TextAnswer id="answer" meaning="Answer" semanticsVersion="1" defaultValue={42} />',
    '<TextAnswer id="answer" meaning="Answer" semanticsVersion="1" />',
  ])('rejects invalid state definitions: %s', (source) => {
    expect(() => parseDocument(source)).toThrow(DocumentValidationError);
  });

  it('retains safe link references and formatting', () => {
    const result = parseDocument(
      '[Documentation][docs]\n\n[docs]: https://example.com/docs\n\n[Section](#access)',
    );
    expect(result.blocks[0]?.children?.[0]?.props?.url).toBe('https://example.com/docs');
    expect(result.blocks[1]?.children?.[0]?.props?.url).toBe('#access');
  });

  it('only carries compatible declarations and validates existing values', () => {
    const first = parseDocument(choice).widgets[0]!;
    const next = parseDocument(choice.replace('defaultValue="Viewer"', 'defaultValue="Editor"'))
      .widgets[0]!;
    expect(areWidgetsCompatible(first, next)).toBe(true);
    expect(areWidgetsCompatible(first, { ...next, meaning: 'Changed meaning' })).toBe(false);
    expect(areWidgetsCompatible(first, { ...next, semanticsVersion: '2' })).toBe(false);
    expect(isWidgetValueValid(next, 'Viewer')).toBe(true);
    expect(isWidgetValueValid(next, 'Admin')).toBe(false);
  });
});
