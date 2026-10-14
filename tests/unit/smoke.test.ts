import { describe, expect, it } from 'vitest';
import { BUSINESS_NAME } from '@/lib/businessConfig';

// Proves that Vitest runs and that the "@" alias reaches src/. Real pricing and money tests come with the spec.
describe('test setup', () => {
  it('runs a test', () => {
    expect(1 + 1).toBe(2);
  });

  it('resolves the @ alias to src', () => {
    expect(BUSINESS_NAME).toBeTruthy();
  });
});
