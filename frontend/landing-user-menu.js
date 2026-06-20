// landing-user-menu.js — avatar dropdown on public landing (signed-in)

const $ = (id) => document.getElementById(id);

/**
 * @param {{ user: { github_login: string } }} me
 */
export function wireLandingUserMenu(me) {
  const wrap = $("user-menu-wrap");
  const btn = $("user-menu-btn");
  const panel = $("user-menu-panel");
  const img = $("user-menu-avatar");
  if (!wrap || !btn || !panel || !img) return;

  const login = me.user.github_login;
  img.src = `https://github.com/${encodeURIComponent(login)}.png?size=64`;
  img.alt = login;
  btn.title = login;
  wrap.removeAttribute("hidden");

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

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

export function hideLandingUserMenu() {
  const wrap = $("user-menu-wrap");
  if (wrap) wrap.setAttribute("hidden", "");
}
