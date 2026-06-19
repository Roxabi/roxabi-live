import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthError, api, escHtml, loginUrl, DASHBOARD_PATH } from './auth.js';

describe('loginUrl', () => {
  it('defaults redirect to dashboard', () => {
    expect(loginUrl()).toBe('/login?redirect=%2Fdashboard');
  });
});

describe('escHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escHtml('<script>"\'&')).toBe('&lt;script&gt;&quot;&#x27;&amp;');
  });
});

describe('api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws AuthError on 401', async () => {
    fetch.mockResolvedValue({ status: 401, ok: false });
    await expect(api('/api/me')).rejects.toBeInstanceOf(AuthError);
  });
});