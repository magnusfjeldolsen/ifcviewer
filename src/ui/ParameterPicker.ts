/**
 * A small searchable list of parameters to pick one from, opened where the
 * right-click menu was (#68: "Colour by parameter…").
 *
 * Lists the parameters of the element that was right-clicked, each with
 * that element's value, so the choice is made looking at real data. Typing
 * filters by name or value; the arrow keys move, Enter picks, Escape or a
 * click elsewhere closes. At most `PICKER_SHOWN` rows are drawn at once.
 */

export interface PickerRow {
  /** The parameter: its flat-row path, e.g. "Pset_WallCommon.FireRating". */
  key: string;
  /** This element's value, as the inspector shows it (with its unit). */
  value: string;
}

export const PICKER_SHOWN = 200;

/** Rows whose key or value contains `filter` (case-insensitive), in their given order. */
export function filterPickerRows(rows: readonly PickerRow[], filter: string): PickerRow[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((r) => r.key.toLowerCase().includes(needle) || r.value.toLowerCase().includes(needle));
}

export class ParameterPicker {
  private el: HTMLElement | null = null;
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
    }
  };
  private onOutside = (e: Event): void => {
    if (this.el && e.target instanceof Node && this.el.contains(e.target)) return;
    this.close();
  };
  private onBlur = (): void => this.close();

  constructor(private readonly parent: HTMLElement) {}

  isOpen(): boolean {
    return this.el !== null;
  }

  /**
   * Open at viewport point (x, y). `heading` says what is being chosen for;
   * `onPick` gets the chosen key, after the picker has closed.
   */
  open(x: number, y: number, heading: string, rows: readonly PickerRow[], onPick: (key: string) => void): void {
    this.close();
    const el = document.createElement('div');
    el.className = 'param-picker';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', heading);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    const title = document.createElement('div');
    title.className = 'param-picker-title';
    title.textContent = heading;

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'param-picker-filter';
    input.placeholder = 'Find a parameter';
    input.setAttribute('aria-label', 'Find a parameter');

    const status = document.createElement('div');
    status.className = 'param-picker-status';

    const list = document.createElement('ul');
    list.className = 'param-picker-list';
    list.setAttribute('role', 'listbox');

    el.append(title, input, status, list);

    let shown: PickerRow[] = [];
    let active = 0;
    const pick = (key: string): void => {
      this.close();
      onPick(key);
    };
    const mark = (): void => {
      list.querySelectorAll('.param-picker-row').forEach((row, i) => {
        row.classList.toggle('active', i === active);
        row.setAttribute('aria-selected', String(i === active));
        if (i === active) (row as HTMLElement).scrollIntoView?.({ block: 'nearest' });
      });
    };
    const draw = (): void => {
      const matching = filterPickerRows(rows, input.value);
      shown = matching.slice(0, PICKER_SHOWN);
      active = 0;
      list.replaceChildren();
      status.textContent =
        matching.length === 0
          ? 'No parameter matches'
          : matching.length > shown.length
            ? `Showing ${shown.length} of ${matching.length}; type to narrow`
            : '';
      const frag = document.createDocumentFragment();
      for (const r of shown) {
        const li = document.createElement('li');
        li.className = 'param-picker-row';
        li.setAttribute('role', 'option');
        li.title = `${r.key} = ${r.value}`;
        const dot = r.key.lastIndexOf('.');
        const key = document.createElement('span');
        key.className = 'param-picker-key';
        if (dot > 0) {
          const group = document.createElement('span');
          group.className = 'param-picker-group';
          group.textContent = r.key.slice(0, dot + 1);
          key.appendChild(group);
        }
        key.appendChild(document.createTextNode(r.key.slice(dot + 1)));
        const value = document.createElement('span');
        value.className = 'param-picker-value';
        value.textContent = r.value;
        li.append(key, value);
        li.addEventListener('click', () => pick(r.key));
        frag.appendChild(li);
      }
      list.appendChild(frag);
      mark();
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (shown.length === 0) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        mark();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (shown[active]) pick(shown[active].key);
      }
    });

    this.parent.appendChild(el);
    this.el = el;
    draw();
    this.clamp(x, y);
    input.focus();

    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('blur', this.onBlur);
  }

  close(): void {
    if (!this.el) return;
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('blur', this.onBlur);
    this.el.remove();
    this.el = null;
  }

  dispose(): void {
    this.close();
  }

  /** Keep the picker inside the window, flipping left / up near the edges. */
  private clamp(x: number, y: number): void {
    if (!this.el) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    this.el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - w))}px`;
    this.el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - h))}px`;
  }
}
