/**
 * The shell's and chat's stroke icons (the approved prototype's set, 24×24, `currentColor`), built with
 * `createElementNS`: no innerHTML, no remote assets. Always decorative (`aria-hidden`): the control carries the name.
 */
const SVG = 'http://www.w3.org/2000/svg';

type Shape = ['path', string] | ['circle', number, number, number] | ['rect', number, number, number, number, number?];

const ICONS = {
  chat: [['path', 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.2 3.6a.5.5 0 0 1-.8-.4V16h0a1 1 0 0 1-1-1z']],
  tasks: [['rect', 4, 4, 16, 16, 2.5], ['path', 'm8 12 2.6 2.6L16 9.2']],
  clock: [['circle', 12, 12, 8.5], ['path', 'M12 7.5V12l3 2']],
  gear: [['circle', 12, 12, 3], ['path', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z']],
  search: [['circle', 11, 11, 6.5], ['path', 'm20 20-4.2-4.2']],
  stop: [['rect', 6.5, 6.5, 11, 11, 2]],
  hash: [['path', 'M5 9h15M4 15h15M10 3 8 21M16 3l-2 18']],
  folder: [['path', 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z']],
  thread: [['path', 'M4 6h11M4 11h7M8 16h12M14 19.5 17.5 16 14 12.5']],
  x: [['path', 'M6 6l12 12M18 6 6 18']],
  chev: [['path', 'm7 9.5 5 5 5-5']],
  'chev-l': [['path', 'm14.5 6-6 6 6 6']],
  down: [['path', 'M12 5v14M6 13l6 6 6-6']],
  'bell-off': [['path', 'M9 4.6A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17M10 20.5a2.2 2.2 0 0 0 4 0M3.5 3.5l17 17']],
  sun: [['circle', 12, 12, 4], ['path', 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4']],
  moon: [['path', 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z']],
  headset: [['path', 'M4.5 14v-2a7.5 7.5 0 0 1 15 0v2M4.5 14h2.5v5H5.5a1 1 0 0 1-1-1zM19.5 14H17v5h1.5a1 1 0 0 0 1-1zM17 19c0 1-1.5 1.5-4 1.5']],
  issue: [['path', 'M12 4 21 19.5H3zM12 10v4M12 17h.01']],
  doc: [['path', 'M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12h6M9 15.5h6']],
  pulse: [['path', 'M3 12h4l2.5-6 5 12L17 12h4']],
  'eye-off': [['path', 'M3.5 3.5l17 17M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 8.5 4.5 9.5 6a17 17 0 0 1-2.7 3.2M6.5 7.6A16 16 0 0 0 2.5 12c1 1.5 4.5 6 9.5 6a9 9 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2']],
  external: [['path', 'M13.5 4.5h6v6M19.5 4.5 11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10']],
  plug: [['path', 'M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4']],
  lock: [['rect', 5, 11, 14, 9, 2], ['path', 'M8 11V8a4 4 0 0 1 8 0v3']],
  users: [['circle', 9, 9, 3.2], ['path', 'M3 19.5a6 6 0 0 1 12 0M15.5 5.8a3.2 3.2 0 0 1 0 6.4M17.5 14a6 6 0 0 1 3.5 5.5']],
  beacon: [['path', 'M12 7.5 16.5 12 12 16.5 7.5 12z']],
  keyboard: [['rect', 2.5, 6, 19, 12, 2], ['path', 'M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14.5h9']],
} satisfies Record<string, Shape[]>;

export type ChatIconName = keyof typeof ICONS;

export function chatIcon(name: ChatIconName, size: '' | 'xs' | 'sm' | 'lg' = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', size === '' ? 'i' : `i ${size}`);
  for (const shape of ICONS[name] as Shape[]) {
    const node = document.createElementNS(SVG, shape[0]);
    if (shape[0] === 'path') node.setAttribute('d', shape[1]);
    else if (shape[0] === 'circle') {
      node.setAttribute('cx', String(shape[1]));
      node.setAttribute('cy', String(shape[2]));
      node.setAttribute('r', String(shape[3]));
    } else {
      node.setAttribute('x', String(shape[1]));
      node.setAttribute('y', String(shape[2]));
      node.setAttribute('width', String(shape[3]));
      node.setAttribute('height', String(shape[4]));
      if (shape[5] !== undefined) node.setAttribute('rx', String(shape[5]));
    }
    svg.append(node);
  }
  return svg;
}
