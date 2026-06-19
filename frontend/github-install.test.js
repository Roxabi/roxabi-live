import { describe, it, expect } from 'vitest';
import { githubInstallUrl, partitionInstallTargets } from './github-install.js';

describe('githubInstallUrl', () => {
  it('builds org deep link', () => {
    const url = new URL(githubInstallUrl({ id: 9, login: 'Roxabi', type: 'Organization' }));
    expect(url.searchParams.get('target_id')).toBe('9');
    expect(url.searchParams.get('target_type')).toBe('Organization');
  });
});

describe('partitionInstallTargets', () => {
  it('splits personal account and orgs', () => {
    const targets = [
      { id: 1, login: 'alice', type: 'User' },
      { id: 2, login: 'Roxabi', type: 'Organization' },
      { id: 3, login: 'Other', type: 'Organization' },
    ];
    const { personal, orgs } = partitionInstallTargets(targets);
    expect(personal?.login).toBe('alice');
    expect(orgs.map(o => o.login)).toEqual(['Roxabi', 'Other']);
  });
});