import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthError, api, hasConsent, setConsent, resolveView, escHtml } from './auth.js';

// ─── resolveView (pure) ───────────────────────────────────────────────────────

describe('resolveView', () => {
  const installationFixture = {
    tenant_id: 1,
    account_login: 'roxabi',
    account_type: 'Organization',
  };

  describe('when install_pending is true', () => {
    it("returns 'install' even if installations is non-empty", () => {
      const me = {
        user: { github_id: 42, github_login: 'alice' },
        active_tenant_id: null,
        install_pending: true,
        installations: [installationFixture],
      };
      expect(resolveView(me, true)).toBe('install');
    });
  });

  describe('when installations is empty', () => {
    it("returns 'install' regardless of consent", () => {
      // Arrange
      const me = {
        user: { github_id: 42, github_login: 'alice' },
        active_tenant_id: null,
        installations: [],
      };
      const consented = true;

      // Act
      const result = resolveView(me, consented);

      // Assert
      expect(result).toBe('install');
    });
  });

  describe('when installations is non-empty and not consented', () => {
    it("returns 'consent'", () => {
      // Arrange
      const me = {
        user: { github_id: 42, github_login: 'alice' },
        active_tenant_id: 1,
        installations: [installationFixture],
      };
      const consented = false;

      // Act
      const result = resolveView(me, consented);

      // Assert
      expect(result).toBe('consent');
    });
  });

  describe('when installations is non-empty and consented', () => {
    it("returns 'dashboard'", () => {
      // Arrange
      const me = {
        user: { github_id: 42, github_login: 'alice' },
        active_tenant_id: 1,
        installations: [installationFixture],
      };
      const consented = true;

      // Act
      const result = resolveView(me, consented);

      // Assert
      expect(result).toBe('dashboard');
    });
  });
});

// ─── consent persistence ──────────────────────────────────────────────────────

describe('consent persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('hasConsent returns false before setConsent is called', () => {
    // Arrange — localStorage cleared in beforeEach

    // Act
    const result = hasConsent('alice');

    // Assert
    expect(result).toBe(false);
  });

  it('hasConsent returns true after setConsent is called for that login', () => {
    // Arrange
    setConsent('alice');

    // Act
    const result = hasConsent('alice');

    // Assert
    expect(result).toBe(true);
  });

  it('consent is scoped per-login: setConsent for alice does not affect bob', () => {
    // Arrange
    setConsent('alice');

    // Act
    const result = hasConsent('bob');

    // Assert
    expect(result).toBe(false);
  });
});

// ─── api() ────────────────────────────────────────────────────────────────────

describe('api()', () => {
  let fetchSpy;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws AuthError on HTTP 401', async () => {
    // Arrange
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 401 }),
    );

    // Act + Assert
    await expect(api('/x')).rejects.toBeInstanceOf(AuthError);
    expect(fetchSpy).toHaveBeenCalledWith('/x', undefined);
  });

  it('resolves to the Response object on HTTP 200', async () => {
    // Arrange
    const mockResponse = new Response('{}', { status: 200 });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    // Act
    const result = await api('/x');

    // Assert
    expect(result.ok).toBe(true);
    expect(result).toBe(mockResponse);
  });

  it('throws a generic Error (not AuthError) on HTTP 500', async () => {
    // Arrange
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    // Act
    const rejection = api('/x');

    // Assert
    await expect(rejection).rejects.toBeInstanceOf(Error);
    await expect(rejection).rejects.not.toBeInstanceOf(AuthError);
  });

  it('forwards opts to fetch', async () => {
    // Arrange
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );

    // Act
    await api('/y', { method: 'POST' });

    // Assert
    expect(fetchSpy).toHaveBeenCalledWith('/y', { method: 'POST' });
  });
});

// ─── escHtml ──────────────────────────────────────────────────────────────────

describe('escHtml', () => {
  it('escapes &', () => {
    expect(escHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes <', () => {
    expect(escHtml('a<b')).toBe('a&lt;b');
  });

  it('escapes >', () => {
    expect(escHtml('a>b')).toBe('a&gt;b');
  });

  it('escapes "', () => {
    expect(escHtml('a"b')).toBe('a&quot;b');
  });

  it("escapes '", () => {
    expect(escHtml("a'b")).toBe('a&#x27;b');
  });

  it('escapes a combined multi-char string', () => {
    expect(escHtml('a<b>&"\''))
      .toBe('a&lt;b&gt;&amp;&quot;&#x27;');
  });

  it('returns a plain string unchanged', () => {
    expect(escHtml('hello world')).toBe('hello world');
  });
});
