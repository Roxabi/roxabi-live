// initial-sync.js — first corpus sync overlay (#223 follow-up)

import { api } from "./auth.js";
import { renderOnboardingSteps } from "./onboarding.js";

const $ = (id) => document.getElementById(id);

const POLL_MS = 2000;
const MAX_WAIT_MS = 180_000;

/**
 * Poll /api/sync/status until the bootstrap reconcile finishes or times out.
 * Keeps the overlay until sync_running clears — not only while issue_count === 0
 * (the first issues can land while the full reconcile is still running).
 */
export async function waitForInitialSync() {
  const gate = $("initial-sync-gate");
  if (!gate) return;

  const started = Date.now();
  let status = await fetchStatus();
  if (!status?.initial_sync && !status?.sync_running) return;

  showOverlay(gate, status.sync_running);

  while (status.sync_running || status.initial_sync) {
    if (Date.now() - started > MAX_WAIT_MS) {
      setOverlayMessage(
        gate,
        "Synchronisation terminée",
        status.issue_count > 0
          ? "Import partiel — actualise la page dans quelques instants si des issues manquent."
          : "Aucun issue trouvé pour les dépôts accessibles. Vérifie les repos sélectionnés sur GitHub.",
      );
      await sleep(2200);
      break;
    }

    await sleep(POLL_MS);
    status = await fetchStatus();
    if (status.sync_running) {
      setOverlayMessage(
        gate,
        "Première synchronisation en cours",
        "Import des issues, labels et dépendances depuis GitHub…",
      );
    } else if (status.initial_sync) {
      setOverlayMessage(
        gate,
        "Préparation de la synchronisation",
        "Démarrage de l'import depuis GitHub…",
      );
    }
  }

  hideOverlay(gate);
}

async function fetchStatus() {
  try {
    const resp = await api("/api/sync/status");
    return resp.json();
  } catch {
    return null;
  }
}

function showOverlay(gate, running) {
  gate.innerHTML = `
    ${renderOnboardingSteps("sync")}
    <div class="initial-sync-dialog" role="status" aria-live="polite" aria-busy="true">
      <div class="initial-sync-spinner" aria-hidden="true"></div>
      <h2 id="initial-sync-title">${running ? "Première synchronisation en cours" : "Préparation de la synchronisation"}</h2>
      <p id="initial-sync-detail">${
        running
          ? "Import des issues, labels et dépendances depuis GitHub…"
          : "Démarrage de l'import depuis GitHub…"
      }</p>
    </div>
  `;
  gate.removeAttribute("hidden");
}

function setOverlayMessage(gate, title, detail) {
  gate.querySelector("#initial-sync-title")?.replaceChildren(document.createTextNode(title));
  gate.querySelector("#initial-sync-detail")?.replaceChildren(document.createTextNode(detail));
}

function hideOverlay(gate) {
  gate.setAttribute("hidden", "");
  gate.innerHTML = "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
