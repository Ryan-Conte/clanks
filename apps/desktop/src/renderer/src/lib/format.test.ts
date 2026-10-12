import { describe, expect, it } from 'vitest';
import { formatSeconds } from './format';

describe('formatSeconds', () => {
  it('says short and long durations briefly', () => {
    expect(formatSeconds(800)).toBe('0.8 s');
    expect(formatSeconds(12_000)).toBe('12 s');
    expect(formatSeconds(125_000)).toBe('2 min 5 s');
    expect(formatSeconds(2 * 3600_000)).toBe('2 h');
    expect(formatSeconds(3 * 3600_000 + 38 * 60_000)).toBe('3 h 38 min');
  });

  it('never shows 60 seconds', () => {
    expect(formatSeconds(59_600)).toBe('1 min');
    expect(formatSeconds(13_139_600)).toBe('3 h 39 min');
  });
});
