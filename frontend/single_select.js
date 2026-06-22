// single_select.js — mono-select dropdown (reuses ms-panel styles)

const INSTANCES = new Set();

document.addEventListener("click", (e) => {
  for (const inst of INSTANCES) {
    if (!inst.open) continue;
    if (inst.trigger.contains(e.target)) continue;
    if (inst.panel.contains(e.target)) continue;
    inst.close();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const inst of INSTANCES) inst.close();
});

export class SingleSelect {
  constructor(trigger, panel, opts = {}) {
    this.trigger = trigger;
    this.panel = panel;
    this.placeholder = opts.placeholder ?? "Select";
    this.onChange = opts.onChange ?? (() => {});
    this.value = null;
    this.items = [];
    this.open = false;

    this.trigger.addEventListener("click", () => {
      for (const inst of INSTANCES) if (inst !== this) inst.close();
      this.toggle();
    });

    INSTANCES.add(this);
  }

  setItems(items, value) {
    this.items = items;
    this.value = value;
    this._buildPanel();
    this._updateTrigger();
  }

  setValue(value) {
    this.value = value;
    this._syncSelection();
    this._updateTrigger();
  }

  getValue() {
    return this.value;
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
    ul.className = "ms-list ss-list";
    ul.setAttribute("role", "listbox");

    for (const item of this.items) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", item.value === this.value ? "true" : "false");
      li.className = `ss-option${item.value === this.value ? " ss-option-on" : ""}`;
      li.textContent = item.label ?? item.value;
      li.dataset.v = item.value;
      li.addEventListener("click", () => {
        this.value = item.value;
        this._syncSelection();
        this._updateTrigger();
        this.close();
        this.onChange(item.value);
      });
      ul.appendChild(li);
    }

    this.panel.appendChild(ul);
  }

  _syncSelection() {
    if (!this.panel) return;
    for (const li of this.panel.querySelectorAll("[role=option]")) {
      const on = li.dataset.v === this.value;
      li.classList.toggle("ss-option-on", on);
      li.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  _updateTrigger() {
    const item = this.items.find((i) => i.value === this.value);
    const label = item?.label ?? item?.value ?? this.placeholder;
    this.trigger.innerHTML = `<span class="ss-value">${label}</span><span class="ss-chevron" aria-hidden="true">▾</span>`;
  }
}
