// landing.js — public homepage CTA (session-aware)

const DASHBOARD_PATH = '/dashboard';
const LOGIN_URL = `/login?redirect=${encodeURIComponent(DASHBOARD_PATH)}`;

async function wireCta() {
  const headerCta = document.getElementById('landing-cta');
  const heroCta = document.getElementById('landing-hero-cta');
  const targets = [headerCta, heroCta].filter(Boolean);
  if (!targets.length) return;

  let href = LOGIN_URL;
  let label = 'Se connecter';

  try {
    const resp = await fetch('/api/me');
    if (resp.ok) {
      href = DASHBOARD_PATH;
      label = 'Ouvrir le dashboard';
    }
  } catch {
    // offline / transient — keep login CTA
  }

  for (const el of targets) {
    el.href = href;
    el.textContent = label;
  }
}

wireCta();