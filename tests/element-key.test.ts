import { describe, it, expect } from 'vitest';
import { makeKey } from '../src/inspector/elementKey';

describe('makeKey', () => {
  it('joins modelId and expressId with a colon', () => {
    expect(makeKey('model-a', 42)).toBe('model-a:42');
  });

  it('handles a UUID-style modelId', () => {
    const uuid = '3f2b1c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
    expect(makeKey(uuid, 7)).toBe(`${uuid}:7`);
  });

  it('handles an expressId of 0', () => {
    expect(makeKey('m', 0)).toBe('m:0');
  });

  it('handles large expressId values', () => {
    expect(makeKey('m', 1234567890)).toBe('m:1234567890');
  });

  it('produces distinct keys for different express ids in the same model', () => {
    expect(makeKey('m', 1)).not.toBe(makeKey('m', 2));
  });

  it('produces distinct keys for the same express id in different models', () => {
    expect(makeKey('a', 5)).not.toBe(makeKey('b', 5));
  });
});
