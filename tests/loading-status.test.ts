import { describe, it, expect } from 'vitest';
import { loadingStatus } from '../src/ui/loadingStatus';

describe('loadingStatus', () => {
  it('says the total is approximate, because it is counted before any geometry exists', () => {
    expect(loadingStatus('a.ifc', { loaded: 3800, total: 7511 })).toBe(
      `Loading a.ifc… (${(3800).toLocaleString()} of about ${(7511).toLocaleString()} elements)`,
    );
  });

  it('never shows more loaded than the total', () => {
    expect(loadingStatus('a.ifc', { loaded: 12, total: 10 })).toContain('12 of about 12');
  });
});
