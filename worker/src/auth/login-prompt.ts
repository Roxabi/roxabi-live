/**
 * GET /login — step 1 onboarding shell (Connexion GitHub).
 * OAuth starts only via ?go=1 or install/reauth/zk flags.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { AUTH_NO_CACHE, sanitizeAuthRedirect } from "./cookies";

export function serveLoginPrompt(
  c: Context<{ Bindings: Env }>,
  redirectAfter: string,
): Response {
  const dest = sanitizeAuthRedirect(redirectAfter);
  const continueUrl = `/login?go=1&redirect=${encodeURIComponent(dest)}`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connexion GitHub · Roxabi Live</title>
<link rel="stylesheet" href="/auth.css">
<link rel="stylesheet" href="/landing.css">
</head>
<body class="login-prompt-body">
<header class="landing-topbar">
  <div class="landing-topbar-inner">
    <a class="landing-brand" href="/">
      <span class="landing-brand-mark">v6</span>
      <span class="landing-brand-name">Roxabi Live</span>
    </a>
  </div>
</header>
<main class="auth-view login-prompt">
  <nav class="onboarding-steps" aria-label="Progression de l'installation">
    <ol>
      <li class="onboarding-step onboarding-step--active" aria-current="step">
        <span class="onboarding-step-marker" aria-hidden="true">1</span>
        <span class="onboarding-step-label">Connexion GitHub</span>
      </li>
      <li class="onboarding-step onboarding-step--pending">
        <span class="onboarding-step-marker" aria-hidden="true">2</span>
        <span class="onboarding-step-label">Installation</span>
      </li>
      <li class="onboarding-step onboarding-step--pending">
        <span class="onboarding-step-marker" aria-hidden="true">3</span>
        <span class="onboarding-step-label">Synchronisation</span>
      </li>
    </ol>
  </nav>
  <div class="login-prompt-card">
    <h1>Identifiez-vous avec GitHub</h1>
    <p class="login-prompt-lead">
      Roxabi Live lit vos issues et dépendances via une application GitHub.
      La connexion est la première étape — l'installation de l'app et la
      synchronisation suivront ensuite.
    </p>
    <a class="auth-login-btn login-prompt-github" href="${continueUrl}">
      Continuer avec GitHub
    </a>
    <p class="login-prompt-foot"><a href="/">Retour à l'accueil</a></p>
  </div>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...AUTH_NO_CACHE },
  });
}