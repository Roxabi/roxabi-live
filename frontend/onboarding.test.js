import { describe, it, expect } from 'vitest';
import { renderOnboardingSteps, ONBOARDING_STEPS } from './onboarding.js';

describe('renderOnboardingSteps', () => {
  it('renders three steps', () => {
    const html = renderOnboardingSteps('install');
    expect(ONBOARDING_STEPS).toHaveLength(3);
    expect(html).toContain('Connexion GitHub');
    expect(html).toContain('Installation');
    expect(html).toContain('Synchronisation');
    expect(html).toContain('onboarding-step--active');
    expect(html).toContain('onboarding-step--done');
  });

  it('marks sync as active on step 3', () => {
    const html = renderOnboardingSteps('sync');
    expect(html).toContain('aria-current="step"');
    expect(html.match(/onboarding-step--done/g)?.length).toBe(2);
  });
});