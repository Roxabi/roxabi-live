// multi_select.js — pill multi-select dropdown component
// Usage: new MultiSelect(triggerEl, panelEl, { placeholder, onChange, clearBtn })

const INSTANCES = new Set();

document.addEventListener('click', e => {
  for (const inst of INSTANCES) {
    if (!inst.open) continue;
    if (inst.trigger.contains(e.target)) continue;
    if (inst.panel.contains(e.target)) continue;
    if (inst.clearBtn && inst.clearBtn.contains(e.target)) continue;
    inst.close();
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const inst of INSTANCES) inst.close();
});

export class MultiSelect {
  constructor(trigger, panel, opts = {}) {
    this.trigger     = trigger;
    this.panel       = panel;
    this.clearBtn    = opts.clearBtn ?? null; // optional inline × next to trigger
    this.placeholder = opts.placeholder ?? 'All';
    this.onChange    = opts.onChange ?? (() => {});
    this.selected    = new Set();
    this.items       = [];
    this.open        = false;

    this.trigger.addEventListener('click', () => {
      // Close siblings first
      for (const inst of INSTANCES) if (inst !== this) inst.close();
      this.toggle();
    });

    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', e => {
        e.stopPropagation();
        this.clear();
      });
    }

    INSTANCES.add(this);
  }

  setItems(items, selected = []) {
    this.items    = items;
    this.selected = new Set(selected);
    this._buildPanel();
    this._updateTrigger();
  }

  setSelected(values) {
    this.selected = new Set(values);
    this._syncCheckboxes();
    this._updateTrigger();
  }

  getSelected() { return [...this.selected]; }

  clear() {
    this.selected.clear();
    this._syncCheckboxes();
    this._updateTrigger();
    this.onChange([]);
  }

  toggle() { this.open ? this.close() : this._open(); }

  _open() {
    this.open = true;
    this.panel.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    const rect = this.trigger.getBoundingClientRect();
    this.panel.style.top  = `${rect.bottom + window.scrollY + 4}px`;
    this.panel.style.left = `${rect.left   + window.scrollX}px`;
  }

  close() {
    if (!this.open) return;
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

      if (item.sublabel) {
        const sub = document.createElement('span');
        sub.className = 'ms-sub';
        sub.textContent = item.sublabel;
        lbl.append(cb, span, sub);
      } else {
        lbl.append(cb, span);
      }
      li.appendChild(lbl);
      ul.appendChild(li);
    }

    const clear = document.createElement('button');
    clear.type      = 'button';
    clear.className = 'ms-clear';
    clear.textContent = 'Clear all';
    clear.addEventListener('click', () => this.clear());

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
    if (this.clearBtn) this.clearBtn.hidden = sel.length === 0;
    if (!sel.length) {
      this.trigger.innerHTML = `<span class="ms-placeholder">${this.placeholder}</span>`;
    } else {
      const pills = sel.map(v => {
        const item = this.items.find(i => i.value === v);
        const toneAttr = item && item.tone ? ` data-tone="${item.tone}"` : '';
        return `<span class="ms-pill"${toneAttr}>${item ? item.label : v}</span>`;
      }).join('');
      this.trigger.innerHTML = pills;
    }
  }
}
