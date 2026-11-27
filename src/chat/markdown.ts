/**
 * The Markdown subset the composer writes, turned into `tokens/1` blocks (the shape ChatKit answers for a message,
 * `docs/API.md` → Message bodies): paragraphs and line breaks, fenced code blocks, `-` / `*` / `1.` lists, `> ` quotes,
 * and inline **bold**, _italic_ / *italic*, ~~strike~~, `code` and [text](https://…) links.
 *
 * Used for a message on its way (the pending row shows what the server will show) and by the mock ChatKit, so both
 * render the same way. Data only: no HTML is produced or parsed; the view turns every string into a text node. Links
 * keep `http(s)` and `mailto` only; anything else stays plain text. Self-contained (no imports) so Node can load it
 * as is (type stripping) from `mock-server/chat.mjs`.
 */

export type MdMark = 'bold' | 'italic' | 'strike';

export type MdToken =
  | { type: 'text'; text: string; marks: MdMark[] }
  | { type: 'break' }
  | { type: 'code'; text: string }
  | { type: 'link'; url: string; text: string; card: boolean };

export type MdBlock =
  | { type: 'paragraph' | 'quote'; tokens: MdToken[] }
  | { type: 'list'; ordered: boolean; items: MdToken[][] }
  | { type: 'code'; text: string };

const DELIMITERS: [string, MdMark][] = [
  ['**', 'bold'],
  ['~~', 'strike'],
  ['_', 'italic'],
  ['*', 'italic'],
];

/** `http(s)` or `mailto` only, without credentials; else `null`. */
function linkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Inline tokens of one line. Unclosed markers stay as typed. */
export function inlineTokens(line: string, marks: MdMark[] = []): MdToken[] {
  const out: MdToken[] = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') out.push({ type: 'text', text: plain, marks: [...marks] });
    plain = '';
  };
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: line.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (line[i] === '[') {
      const close = line.indexOf('](', i + 1);
      const end = close < 0 ? -1 : line.indexOf(')', close + 2);
      const url = end < 0 ? null : linkUrl(line.slice(close + 2, end));
      if (url !== null && close > i + 1) {
        flush();
        out.push({ type: 'link', url, text: line.slice(i + 1, close), card: false });
        i = end + 1;
        continue;
      }
    }
    const delimiter = DELIMITERS.find(([marker]) => line.startsWith(marker, i));
    if (delimiter !== undefined) {
      const [marker, mark] = delimiter;
      const end = line.indexOf(marker, i + marker.length);
      // A real span: not empty, no space right inside the markers, and `_` only at word edges (snake_case stays).
      const inner = end < 0 ? '' : line.slice(i + marker.length, end);
      const wordy = marker === '_' && ((i > 0 && /\w/.test(line[i - 1])) || /\w/.test(line[end + 1] ?? ''));
      if (end > 0 && inner.trim() === inner && inner !== '' && !wordy) {
        flush();
        out.push(...inlineTokens(inner, marks.includes(mark) ? marks : [...marks, mark]));
        i = end + marker.length;
        continue;
      }
    }
    plain += line[i];
    i += 1;
  }
  flush();
  return out;
}

const LIST = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/;

/** Blocks of a whole message (`\n` line ends). */
export function markdownBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', tokens: joinLines(paragraph) });
    paragraph = [];
  };
  const endQuote = () => {
    if (quote.length > 0) blocks.push({ type: 'quote', tokens: joinLines(quote) });
    quote = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      const end = lines.findIndex((next, j) => j > i && next.trim() === '```');
      if (end > i) {
        endParagraph();
        endQuote();
        blocks.push({ type: 'code', text: lines.slice(i + 1, end).join('\n') });
        i = end;
        continue;
      }
    }
    const item = LIST.exec(line);
    if (item !== null) {
      endParagraph();
      endQuote();
      const ordered = item[2] !== undefined;
      const last = blocks[blocks.length - 1];
      const tokens = inlineTokens(item[3]);
      if (last?.type === 'list' && last.ordered === ordered) last.items.push(tokens);
      else blocks.push({ type: 'list', ordered, items: [tokens] });
      continue;
    }
    if (line.startsWith('> ') || line === '>') {
      endParagraph();
      quote.push(line.slice(2));
      continue;
    }
    endQuote();
    if (line.trim() === '') {
      endParagraph();
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  endQuote();
  return blocks;
}

function joinLines(lines: string[]): MdToken[] {
  return lines.flatMap((line, i) => (i === 0 ? inlineTokens(line) : [{ type: 'break' as const }, ...inlineTokens(line)]));
}
