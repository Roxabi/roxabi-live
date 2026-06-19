import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const apiMock = vi.fn();

vi.mock('./auth.js', () => ({
  api: (...args) => apiMock(...args),
}));

const { waitForInitialSync } = await import('./initial-sync.js');

function mockStatus(body) {
  apiMock.mockResolvedValue({
    json: async () => body,
  });
}

describe('waitForInitialSync', () => {
  let gate;

  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.mockReset();
    gate = document.createElement('div');
    gate.id = 'initial-sync-gate';
    gate.setAttribute('hidden', '');
    document.body.appendChild(gate);
  });

  afterEach(() => {
    vi.useRealTimers();
    gate?.remove();
  });

  it('skips when neither initial_sync nor sync_running', async () => {
    mockStatus({ initial_sync: false, sync_running: false, issue_count: 10 });

    await waitForInitialSync();

    expect(gate.hasAttribute('hidden')).toBe(true);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('keeps overlay while sync_running after first issues land', async () => {
    mockStatus({ initial_sync: true, sync_running: false, issue_count: 0 });
    const p = waitForInitialSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.hasAttribute('hidden')).toBe(false);

    mockStatus({ initial_sync: false, sync_running: true, issue_count: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(gate.hasAttribute('hidden')).toBe(false);
    expect(gate.textContent).toContain('Première synchronisation en cours');

    mockStatus({ initial_sync: false, sync_running: false, issue_count: 42 });
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(gate.hasAttribute('hidden')).toBe(true);
  });

  it('shows overlay when reload catches an in-flight bootstrap', async () => {
    mockStatus({ initial_sync: false, sync_running: true, issue_count: 5 });

    const p = waitForInitialSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.hasAttribute('hidden')).toBe(false);

    mockStatus({ initial_sync: false, sync_running: false, issue_count: 5 });
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(gate.hasAttribute('hidden')).toBe(true);
  });
});