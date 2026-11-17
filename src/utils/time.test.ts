import { describe, expect, it } from 'vitest';
import { parseDbTimestamp } from './time';

describe('parseDbTimestamp', () => {
  it('reads SQLite CURRENT_TIMESTAMP values as UTC, whatever the local zone', () => {
    expect(parseDbTimestamp('2026-01-02 03:04:05').toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('passes ISO strings with a zone through unchanged', () => {
    expect(parseDbTimestamp('2026-01-02T03:04:05.000Z').toISOString()).toBe(
      '2026-01-02T03:04:05.000Z'
    );
    expect(parseDbTimestamp('2026-01-02T03:04:05+02:00').toISOString()).toBe(
      '2026-01-02T01:04:05.000Z'
    );
  });

  it('does not treat near-miss formats as SQLite timestamps', () => {
    // Fractional seconds are not what CURRENT_TIMESTAMP produces, so they take
    // the plain new Date path instead of being forced to UTC.
    const viaDate = new Date('2026-01-02 03:04:05.123').getTime();
    expect(parseDbTimestamp('2026-01-02 03:04:05.123').getTime()).toBe(viaDate);
  });

  it('returns an Invalid Date for garbage', () => {
    expect(Number.isNaN(parseDbTimestamp('not a date').getTime())).toBe(true);
  });
});
