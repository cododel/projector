import { describe, expect, it } from 'vitest';
import metadata from '../package.json';
import { getGuide, GUIDE_TOPICS, GUIDE_VERSION, SERVER_INSTRUCTIONS } from '../src/guide';
import { parseDocument } from '../src/document';

describe('bundled agent guidance', () => {
  it('delivers purpose, discovery and authority boundaries in the first 512 ASCII characters', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, 'ascii')).toBe(SERVER_INSTRUCTIONS.length);
    expect(SERVER_INSTRUCTIONS.slice(0, 512)).toContain('get_blueprint_guide(topic="overview")');
    expect(SERVER_INSTRUCTIONS).toContain('Draft feedback is private until Save');
    expect(SERVER_INSTRUCTIONS).toContain('approval does not authorize implementation');
  });

  it('defaults to a versioned overview and navigable bundled references', () => {
    const result = getGuide();
    expect(result.guideVersion).toBe(metadata.version);
    expect(GUIDE_VERSION).toBe(metadata.version);
    expect(result.topic).toBe('overview');
    expect(result.content).toContain('skills');
    expect(result.references.map((item) => item.id)).toContain('permissions-plan');
  });

  it.each(GUIDE_TOPICS)('serves the %s topic offline with its version', (topic) => {
    const result = getGuide({ topic });
    expect(result.topic).toBe(topic);
    expect(result.guideVersion).toBe(metadata.version);
    expect(result.content.length).toBeGreaterThan(300);
  });

  it('describes artifact-scoped sessions, explicit Save and saved-only attachment reads', () => {
    const all = getGuide({ topic: 'all' }).content;
    expect(all).toContain('originSession');
    expect(all).toContain('savedStateId');
    expect(all).toContain('read_attachment');
    expect(all).toContain('show_content');
    expect(all).toContain('Copy update message');
    expect(all).not.toContain('bind a session');
    expect(all).not.toContain('private until Submit');
  });

  it('loads references separately and keeps examples out of the full normative guide', () => {
    const all = getGuide({ topic: 'all' });
    const example = getGuide({ reference: 'permissions-plan' });
    expect(example.reference).toBe('permissions-plan');
    expect(example.guideVersion).toBe(all.guideVersion);
    expect(example.content).toContain('Workspace permissions change');
    expect(all.content).not.toContain('# Workspace permissions change');
  });

  it('rejects ambiguous requests and arbitrary reference paths with actionable IDs', () => {
    expect(() => getGuide({ topic: 'overview', reference: 'permissions-plan' })).toThrow(
      'topic OR reference',
    );
    expect(() => getGuide({ topic: 'unavailable' })).toThrow('Available topics');
    expect(() => getGuide({ reference: '../../AGENTS.md' })).toThrow('Available references');
    expect(() => getGuide({ reference: 'toString' })).toThrow('Available references');
  });

  it('provides examples accepted by the actual constrained document compiler', () => {
    const reference = getGuide({ reference: 'widget-api' });
    const parsed = parseDocument(reference.content);
    expect(parsed.widgets.map((widget) => widget.id)).toEqual([
      'revocation',
      'owner-transfer',
      'acceptance',
    ]);
    expect(parsed.widgets.find((widget) => widget.id === 'revocation')).toMatchObject({
      semanticsVersion: '1',
      defaultValue: 'Next request',
    });
    expect(
      parseDocument(getGuide({ reference: 'permissions-plan' }).content).blocks.length,
    ).toBeGreaterThan(1);
  });
});
