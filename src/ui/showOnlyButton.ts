/**
 * The eye button that shows only some elements (#70), beside a value in the
 * Parameters list, a colour legend entry and a Totals group line. A click
 * passes `additive` when Ctrl, Shift or Cmd is held: show them as well. The
 * same goes for Enter or Space with one of those keys held, and the
 * accessible name says so.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** What holding Shift or Ctrl does, as the accessible name says it. */
export const ADD_HINT = 'Shift or Ctrl: show as well';

export function showOnlyButton(label: string, title: string, onShow: (additive: boolean) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'show-only-btn';
  b.title = title;
  b.setAttribute('aria-label', `${label} (${ADD_HINT})`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const eye = document.createElementNS(SVG_NS, 'path');
  eye.setAttribute('d', 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z');
  const pupil = document.createElementNS(SVG_NS, 'circle');
  pupil.setAttribute('cx', '12');
  pupil.setAttribute('cy', '12');
  pupil.setAttribute('r', '3');
  svg.append(eye, pupil);
  b.appendChild(svg);
  b.addEventListener('click', (e) => {
    // Never also the row's own click (select).
    e.stopPropagation();
    onShow(e.ctrlKey || e.shiftKey || e.metaKey);
  });
  // A key press activates a button with a click that does not reliably
  // carry the modifier keys, so the "as well" variant is handled here.
  b.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !(e.ctrlKey || e.shiftKey || e.metaKey)) return;
    e.preventDefault();
    onShow(true);
  });
  return b;
}
