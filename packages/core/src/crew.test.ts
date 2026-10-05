import { describe, expect, it } from 'vitest';
import { clankFrontmatterSchema, estimateTokens } from './crew';
import { modelIdSchema } from './models';
import { userProfileSchema } from './settings';
import { ALWAYS_AVAILABLE_TOOLS, TOOL_NAMES, toolsMatching } from './tools';

const maker = {
  id: 'forge',
  name: 'Forge',
  role: 'Engineer',
  summary: 'Writes the code.',
  outputs: ['pr'],
  workflow: { kind: 'maker', stage: 'build', bounce_to: ['scribe'] },
  model: { tags: ['code'], needs: ['tools'], prefers: [], min_context: 32768, temperature: 0.2 },
  tools: { allow: ['fs_read'], ask: ['browser_*'] },
};

describe('clank frontmatter', () => {
  it('accepts a maker and fills in the empty tool lists', () => {
    const parsed = clankFrontmatterSchema.parse(maker);
    expect(parsed.tools).toEqual({ allow: ['fs_read'], ask: ['browser_*'], deny: [] });
  });

  it('rejects a typo rather than ignoring it', () => {
    const result = clankFrontmatterSchema.safeParse({
      ...maker,
      model: { ...maker.model, temprature: 0.2 },
    });
    expect(result.success).toBe(false);
  });

  it('needs a maker to make something, in a maker stage', () => {
    expect(clankFrontmatterSchema.safeParse({ ...maker, outputs: [] }).success).toBe(false);
    expect(
      clankFrontmatterSchema.safeParse({ ...maker, workflow: { kind: 'maker', stage: 'qa' } })
        .success,
    ).toBe(false);
  });

  it('places a custom checker after the stage it names', () => {
    const checker = {
      ...maker,
      outputs: [],
      workflow: { kind: 'checker', stage: 'security', applies_to: ['pr'] },
    };
    expect(clankFrontmatterSchema.safeParse(checker).success).toBe(false);
    expect(
      clankFrontmatterSchema.safeParse({
        ...checker,
        workflow: { ...checker.workflow, after: 'qa' },
      }).success,
    ).toBe(true);
  });
});

describe('tools', () => {
  it('matches exact names and groups', () => {
    expect(toolsMatching('fs_read')).toEqual(['fs_read']);
    expect(toolsMatching('browser_*')).toContain('browser_screenshot');
    expect(toolsMatching('browser_*').every((t) => t.startsWith('browser_'))).toBe(true);
    expect(toolsMatching('nope')).toEqual([]);
    expect(toolsMatching('*')).toEqual([]);
  });

  it('only gives every clank tools that exist', () => {
    expect(ALWAYS_AVAILABLE_TOOLS.every((t) => TOOL_NAMES.includes(t))).toBe(true);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });
});

describe('user profile', () => {
  it('takes IANA time zones, or none', () => {
    const profile = { name: 'Sam', timeZone: 'Australia/Sydney', language: '', preferences: '' };
    expect(userProfileSchema.parse(profile)).toEqual(profile);
    expect(userProfileSchema.safeParse({ ...profile, timeZone: '' }).success).toBe(true);
    expect(userProfileSchema.safeParse({ ...profile, timeZone: 'Mars/Olympus' }).success).toBe(
      false,
    );
  });
});

describe('model ids', () => {
  it('names models from the catalog, Hugging Face and Ollama', () => {
    for (const id of [
      'qwen3.5:9b',
      'hf.co/unsloth/Qwen3-GGUF:Q4_K_M',
      'ollama/llama3.2:3b',
      'ollama/library-user/model:7b-q4_K_M',
    ]) {
      expect(modelIdSchema.safeParse(id).success, id).toBe(true);
    }
    expect(modelIdSchema.safeParse('ollama/llama3.2').success).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('errs high', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
