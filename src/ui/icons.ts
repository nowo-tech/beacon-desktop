/**
 * Inline stroke icons (24×24, `currentColor`), built with `createElementNS`: no innerHTML, no remote assets. Shapes
 * follow the Tabler set used by Beacon. Always decorative (`aria-hidden`): the control carries the accessible name.
 */
const SVG = 'http://www.w3.org/2000/svg';

type Shape = ['path', string] | ['circle', number, number, number] | ['rect', number, number, number, number];

const ICONS = {
  clock: [['circle', 12, 12, 9], ['path', 'M12 7v5l3 3']],
  external: [['path', 'M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6'], ['path', 'M11 13l9-9'], ['path', 'M15 4h5v5']],
  settings: [
    [
      'path',
      'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065z',
    ],
    ['circle', 12, 12, 3],
  ],
  search: [['circle', 10, 10, 7], ['path', 'M21 21l-6-6']],
  copy: [['rect', 8, 8, 12, 12], ['path', 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2']],
  refresh: [['path', 'M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4'], ['path', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4']],
  play: [['path', 'M7 4v16l13-8z']],
  stop: [['rect', 5, 5, 14, 14]],
  switch: [['path', 'M7 10h14l-4-4'], ['path', 'M17 14H3l4 4']],
  pin: [['path', 'M15 4.5l-4 4-4 1.5-1.5 1.5 7 7 1.5-1.5 1.5-4 4-4'], ['path', 'M9 15l-4.5 4.5'], ['path', 'M14.5 4L20 9.5']],
  check: [['path', 'M5 12l5 5L20 7']],
  alert: [['circle', 12, 12, 9], ['path', 'M12 8v4'], ['path', 'M12 16h.01']],
  back: [['path', 'M5 12h14'], ['path', 'M5 12l6 6'], ['path', 'M5 12l6-6']],
  close: [['path', 'M18 6L6 18'], ['path', 'M6 6l12 12']],
  list: [['path', 'M9 6h11'], ['path', 'M9 12h11'], ['path', 'M9 18h11'], ['path', 'M5 6v.01'], ['path', 'M5 12v.01'], ['path', 'M5 18v.01']],
  /** "Full view": three columns. */
  columns: [['rect', 3, 4, 18, 16], ['path', 'M9 4v16'], ['path', 'M15 4v16']],
  /** "Compact view": one narrow column. */
  compact: [['rect', 7, 3, 10, 18], ['path', 'M10 7h4']],
  help: [['circle', 12, 12, 9], ['path', 'M12 17v.01'], ['path', 'M12 13.5a1.5 1.5 0 0 1 1-1.5 2.6 2.6 0 1 0-3-4']],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon icon-${name}`);
  for (const shape of ICONS[name] as Shape[]) {
    const node = document.createElementNS(SVG, shape[0]);
    if (shape[0] === 'path') node.setAttribute('d', shape[1]);
    if (shape[0] === 'circle') {
      node.setAttribute('cx', String(shape[1]));
      node.setAttribute('cy', String(shape[2]));
      node.setAttribute('r', String(shape[3]));
    }
    if (shape[0] === 'rect') {
      node.setAttribute('x', String(shape[1]));
      node.setAttribute('y', String(shape[2]));
      node.setAttribute('width', String(shape[3]));
      node.setAttribute('height', String(shape[4]));
      node.setAttribute('rx', '2');
    }
    svg.append(node);
  }
  return svg;
}
