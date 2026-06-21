// user-menu.js — avatar trigger + account dropdown

import { signOut } from "./auth.js";
import { getDisplayName, openSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

/**
 * @param {{ user: { github_login: string, github_id?: number } }} me
 */
export function wireUserMenu(me) {
  const wrap = $("user-menu-wrap");
  const btn = $("user-menu-btn");
  const panel = $("user-menu-panel");
  const img = $("user-menu-avatar");
  if (!wrap || !btn || !panel || !img) return;

  const login = me.user.github_login;
  img.src = `https://github.com/${encodeURIComponent(login)}.png?size=64`;
  img.alt = login;
  btn.title = getDisplayName(login);
  wrap.removeAttribute("hidden");

  document.addEventListener("roxabi:display-name", (e) => {
    if (e.detail?.login === login) {
      btn.title = e.detail.name;
    }
  });

  if (btn.dataset.wired) return;
  btn.dataset.wired = "1";

  const close = () => {
    panel.setAttribute("hidden", "");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = panel.hasAttribute("hidden");
    if (open) {
      panel.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
    } else {
      close();
    }
  });

  $("user-menu-settings")?.addEventListener("click", () => {
    close();
    openSettings(me);
  });

  $("user-menu-signout")?.addEventListener("click", async () => {
    close();
    await signOut({ to: "/" });
  });

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}
