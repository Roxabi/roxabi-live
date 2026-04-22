// multi_select.js — pill multi-select dropdown component
// Usage: new MultiSelect(triggerEl, panelEl, { onChange })

export class MultiSelect {
  /**
   * @param {HTMLElement} trigger - the button that shows current selection
   * @param {HTMLElement} panel   - the floating checkbox panel
   * @param {{ placeholder: string, onChange: (values: string[]) => void }} opts
   */
  constructor(trigger, panel, opts = {}) {
    this.trigger     = trigger;
    this.panel       = panel;
    this.placeholder = opts.placeholder ?? 'All';
    this.onChange    = opts.onChange ?? (() => {});
    this.selected    = new Set();
    this.items       = []; // [{ value, label }]
    this.open        = false;

    this.trigger.addEventListener('click', e => { e.stopPropagation(); this.toggle(); });
    document.addEventListener('click',  e => { if (!this.panel.contains(e.target)) this.close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
  }

  // Populate options (replaces existing)
  setItems(items, selected = []) {
    this.items    = items;
    this.selected = new Set(selected);
    this._buildPanel();
    this._updateTrigger();
  }

  // Update selected set from outside (no onChange fire)
  setSelected(values) {
    this.selected = new Set(values);
    this._syncCheckboxes();
    this._updateTrigger();
  }

  getSelected() {
    return [...this.selected];
  }

  toggle() {
    this.open ? this.close() : this._open();
  }

  _open() {
    this.open = true;
    this.panel.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    // position panel below trigger
    const rect = this.trigger.getBoundingClientRect();
    this.panel.style.top  = `${rect.bottom + window.scrollY + 4}px`;
    this.panel.style.left = `${rect.left   + window.scrollX}px`;
  }

  close() {
    this.open = false;
    this.panel.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
  }

  _buildPanel() {
    this.panel.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'ms-list';
    ul.setAttribute('role', 'listbox');
    ul.setAttribute('aria-multiselectable', 'true');

    for (const item of this.items) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', this.selected.has(item.value) ? 'true' : 'false');

      const lbl = document.createElement('label');
      lbl.className = 'ms-item';

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.value   = item.value;
      cb.checked = this.selected.has(item.value);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(item.value);
        else            this.selected.delete(item.value);
        li.setAttribute('aria-selected', cb.checked ? 'true' : 'false');
        this._updateTrigger();
        this.onChange([...this.selected]);
      });

      const span = document.createElement('span');
      span.textContent = item.label;

      lbl.append(cb, span);
      li.appendChild(lbl);
      ul.appendChild(li);
    }

    // Clear-all link
    const clear = document.createElement('button');
    clear.type      = 'button';
    clear.className = 'ms-clear';
    clear.textContent = 'Clear all';
    clear.addEventListener('click', () => {
      this.selected.clear();
      this._syncCheckboxes();
      this._updateTrigger();
      this.onChange([]);
    });

    this.panel.appendChild(ul);
    this.panel.appendChild(clear);
  }

  _syncCheckboxes() {
    if (!this.panel) return;
    for (const cb of this.panel.querySelectorAll('input[type=checkbox]')) {
      cb.checked = this.selected.has(cb.value);
      const li = cb.closest('li');
      if (li) li.setAttribute('aria-selected', cb.checked ? 'true' : 'false');
    }
  }

  _updateTrigger() {
    const sel = [...this.selected];
    if (!sel.length) {
      this.trigger.innerHTML = `<span class="ms-placeholder">${this.placeholder}</span>`;
    } else {
      const pills = sel.map(v => {
        const item = this.items.find(i => i.value === v);
        return `<span class="ms-pill">${item ? item.label : v}</span>`;
      }).join('');
      this.trigger.innerHTML = pills;
    }
  }
}
