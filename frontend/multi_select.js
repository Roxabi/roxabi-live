// multi_select.js — pill multi-select dropdown component
// Usage: new MultiSelect(triggerEl, panelEl, { placeholder, onChange, clearBtn })

const INSTANCES = new Set();

document.addEventListener("click", (e) => {
  for (const inst of INSTANCES) {
    if (!inst.open) continue;
    if (inst.trigger.contains(e.target)) continue;
    if (inst.panel.contains(e.target)) continue;
    if (inst.clearBtn?.contains(e.target)) continue;
    inst.close();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const inst of INSTANCES) inst.close();
});

export class MultiSelect {
  constructor(trigger, panel, opts = {}) {
    this.trigger = trigger;
    this.panel = panel;
    this.clearBtn = opts.clearBtn ?? null; // optional inline × next to trigger
    this.placeholder = opts.placeholder ?? "All";
    this.onChange = opts.onChange ?? (() => {});
    this.maxVisiblePills = opts.maxVisiblePills ?? 2;
    this.selected = new Set();
    this.items = [];
    this.open = false;
    this.pillsExpanded = false;

    this.trigger.addEventListener("click", (e) => {
      if (e.target.closest("[data-ms-expand]")) {
        e.stopPropagation();
        this.pillsExpanded = !this.pillsExpanded;
        this._updateTrigger();
        return;
      }
      // Close siblings first
      for (const inst of INSTANCES) if (inst !== this) inst.close();
      this.toggle();
    });

    this.trigger.addEventListener("keydown", (e) => {
      const more = e.target.closest("[data-ms-expand]");
      if (!more) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        this.pillsExpanded = !this.pillsExpanded;
        this._updateTrigger();
      }
    });

    if (this.clearBtn) {
      this.clearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.clear();
      });
    }

    INSTANCES.add(this);
  }

  setItems(items, selected = []) {
    this.items = items;
    this.selected = new Set(selected);
    this.pillsExpanded = false;
    this._buildPanel();
    this._updateTrigger();
  }

  setSelected(values) {
    this.selected = new Set(values);
    this.pillsExpanded = false;
    this._syncCheckboxes();
    this._updateTrigger();
  }

  getSelected() {
    return [...this.selected];
  }

  clear() {
    this.selected.clear();
    this.pillsExpanded = false;
    this._syncCheckboxes();
    this._updateTrigger();
    this.onChange([]);
  }

  toggle() {
    this.open ? this.close() : this._open();
  }

  _open() {
    this.open = true;
    this.panel.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    const rect = this.trigger.getBoundingClientRect();
    this.panel.style.top = `${rect.bottom + window.scrollY + 4}px`;
    this.panel.style.left = `${rect.left + window.scrollX}px`;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.panel.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
  }

  _buildPanel() {
    this.panel.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "ms-list";
    ul.setAttribute("role", "listbox");
    ul.setAttribute("aria-multiselectable", "true");

    for (const item of this.items) {
      // Separator item — non-interactive divider
      if (item.separator) {
        const li = document.createElement("li");
        li.className = "ms-sep";
        li.setAttribute("role", "separator");
        li.setAttribute("aria-hidden", "true");
        if (item.label) {
          const span = document.createElement("span");
          span.textContent = item.label;
          li.appendChild(span);
        }
        ul.appendChild(li);
        continue;
      }

      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", this.selected.has(item.value) ? "true" : "false");

      const lbl = document.createElement("label");
      lbl.className = `ms-item${item.archived ? " ms-item-archived" : ""}`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = item.value;
      cb.checked = this.selected.has(item.value);
      cb.addEventListener("change", () => {
        if (cb.checked) this.selected.add(item.value);
        else this.selected.delete(item.value);
        li.setAttribute("aria-selected", cb.checked ? "true" : "false");
        this.pillsExpanded = false;
        this._updateTrigger();
        this.onChange([...this.selected]);
      });

      const span = document.createElement("span");
      span.textContent = item.label;

      lbl.append(cb, span);

      const meta = document.createElement("span");
      meta.className = "ms-meta";
      let hasMeta = false;

      if (item.badge) {
        const badge = document.createElement("span");
        badge.className = `ms-badge ms-badge-${item.badge}`;
        badge.textContent = item.badge;
        meta.appendChild(badge);
        hasMeta = true;
      } else if (item.sublabel) {
        const sub = document.createElement("span");
        sub.className = "ms-sub";
        sub.textContent = item.sublabel;
        meta.appendChild(sub);
        hasMeta = true;
      }

      if (item.archived) {
        const sub = document.createElement("span");
        sub.className = "ms-sub";
        sub.textContent = "archived";
        meta.appendChild(sub);
        hasMeta = true;
      }

      if (hasMeta) lbl.appendChild(meta);

      li.appendChild(lbl);
      ul.appendChild(li);
    }

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "ms-clear";
    clear.textContent = "Clear all";
    clear.addEventListener("click", () => this.clear());

    this.panel.appendChild(ul);
    this.panel.appendChild(clear);
  }

  _syncCheckboxes() {
    if (!this.panel) return;
    for (const cb of this.panel.querySelectorAll("input[type=checkbox]")) {
      cb.checked = this.selected.has(cb.value);
      const li = cb.closest("li");
      if (li) li.setAttribute("aria-selected", cb.checked ? "true" : "false");
    }
  }

  _pillHtml(value) {
    const item = this.items.find((i) => i.value === value);
    const toneAttr = item?.tone ? ` data-tone="${item.tone}"` : "";
    const label = item ? item.label : value;
    return `<span class="ms-pill"${toneAttr}>${label}</span>`;
  }

  _expandPill(label) {
    return `<span class="ms-pill ms-pill-more" data-ms-expand tabindex="0" role="button" aria-label="${label}">…</span>`;
  }

  _updateTrigger() {
    const sel = [...this.selected];
    if (this.clearBtn) this.clearBtn.hidden = sel.length === 0;
    if (!sel.length) {
      this.trigger.classList.remove("ms-trigger-expanded");
      this.trigger.innerHTML = `<span class="ms-placeholder">${this.placeholder}</span>`;
      return;
    }

    const max = this.maxVisiblePills;
    const collapsed = sel.length > max && !this.pillsExpanded;

    if (collapsed) {
      const hidden = sel.length - max;
      this.trigger.classList.remove("ms-trigger-expanded");
      this.trigger.innerHTML =
        sel
          .slice(0, max)
          .map((v) => this._pillHtml(v))
          .join("") + this._expandPill(`Show ${hidden} more`);
      return;
    }

    const pills = sel.map((v) => this._pillHtml(v)).join("");
    if (sel.length > max) {
      this.trigger.classList.add("ms-trigger-expanded");
      this.trigger.innerHTML = pills + this._expandPill("Show less");
    } else {
      this.trigger.classList.remove("ms-trigger-expanded");
      this.trigger.innerHTML = pills;
    }
  }
}
