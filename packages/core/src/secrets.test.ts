import { describe, expect, it } from 'vitest';
import { secretRefSchema } from './secrets';

describe('secretRefSchema', () => {
  it.each(['provider:anthropic', 'hf:token', 'connection.stripe-test_1'])('accepts %s', (ref) => {
    expect(secretRefSchema.safeParse(ref).success).toBe(true);
  });

  it.each(['', 'Provider:Anthropic', ':leading', 'has space', '../escape', 'a'.repeat(129)])(
    'rejects %j',
    (ref) => {
      expect(secretRefSchema.safeParse(ref).success).toBe(false);
    },
  );
});
