import { describe, it, expect } from 'vitest';

describe('landing module', () => {
  it('loads without import errors', async () => {
    await expect(import('./landing.js')).resolves.toBeDefined();
  });
});