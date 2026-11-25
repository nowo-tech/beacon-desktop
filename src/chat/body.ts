/**
 * Message bodies (`tokens/1`, Q-BD-16): every string becomes a text node; the server's HTML is never injected (there is
 * none). Links open outside the app, and only `http(s)` / `mailto` (checked in types.ts and again in Rust). A reference
 * the reader may not open is the neutral "not visible" placeholder, with no type, id or title (R2). `mention.name` is
 * author-controlled text: shown as text, never trusted for anything else.
 */
import { type Child, h } from '../ui/dom';
import { chatIcon } from './icons';
import type { ChatText } from './i18n';
import type { Block, Mark, Token } from './types';

export interface BodyOptions {
  t: ChatText;
  /** The reader's uuid: their own mentions are highlighted. */
  me: string | null;
  /** Opens a checked link outside the app. */
  open(url: string): void;
}

const MARK_TAGS: Record<Mark, 'strong' | 'em' | 's'> = { bold: 'strong', italic: 'em', strike: 's' };

function marked(text: string, marks: Mark[]): Child {
  let node: Child = text;
  for (const mark of marks) node = h(MARK_TAGS[mark], {}, node);
  return node;
}

const KIND_ICON: Record<string, Parameters<typeof chatIcon>[0]> = { task: 'tasks', issue: 'issue', wiki: 'doc', monitor: 'pulse' };

function linkTo(url: string, label: string, options: BodyOptions, className: string, ...content: Child[]): HTMLAnchorElement {
  const link = h('a', { class: className, attrs: { href: url, rel: 'noopener noreferrer', title: url } }, ...(content.length > 0 ? content : [label]));
  link.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.open(url);
  });
  return link;
}

/** The host a link text or URL names (`bank.example`, `https://bank.example/x`), lower case, or `null`. */
export function hostOf(text: string): string | null {
  const match = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i.exec(text.trim());
  if (match === null) return null;
  try {
    return new URL(`https://${match[1]}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function renderToken(token: Token, options: BodyOptions): Child {
  switch (token.type) {
    case 'text':
      return marked(token.text, token.marks);
    case 'break':
      return h('br');
    case 'code':
      return h('code', {}, token.text);
    case 'mention': {
      const me = token.userUuid !== null && token.userUuid === options.me;
      return h('span', { class: me ? 'mention me' : 'mention' }, `@${token.name.replace(/^@/, '')}`);
    }
    case 'link': {
      if (token.url === null) return h('span', {}, token.text);
      const link = linkTo(token.url, token.text, options, 'm-link');
      // Text that reads like another site than the target shows the real host next to it (audit ZBZ-I1).
      const shown = hostOf(token.text);
      const real = hostOf(token.url);
      return shown !== null && real !== null && shown !== real ? h('span', { class: 'm-link-wrap' }, link, h('span', { class: 'm-host' }, ` (${real})`)) : link;
    }
    case 'reference': {
      if (!token.visible) {
        return h(
          'span',
          { class: 'ref ref-hidden', attrs: { title: options.t('refHiddenTitle') } },
          h('span', { class: 'r-k', attrs: { 'aria-hidden': 'true' } }, chatIcon('eye-off', 'xs')),
          h('span', { class: 'r-t' }, token.text || options.t('refHidden')),
        );
      }
      const kind = KIND_ICON[token.refType] ?? 'doc';
      // The type becomes a class only when it is a known one (server text never reaches a class name as is).
      const typeClass = `ref ref-${token.refType in KIND_ICON ? token.refType : 'other'}`;
      const parts: Child[] = [
        h('span', { class: 'r-k', attrs: { 'aria-hidden': 'true' } }, chatIcon(kind, 'xs')),
        token.id !== '' && token.refType !== 'wiki' ? h('span', { class: 'r-id' }, token.id) : null,
        h('span', { class: 'r-t' }, token.title || token.typeLabel),
        token.badge !== '' ? h('span', { class: `r-s tone-${token.tone}` }, token.badge) : null,
      ];
      const label = [token.typeLabel, token.id, token.title].filter((part) => part !== '').join(' ');
      if (token.url === null) return h('span', { class: typeClass, attrs: { title: label } }, ...parts);
      const link = linkTo(token.url, label, options, typeClass, ...parts);
      link.title = options.t('refOpen', { label });
      return link;
    }
  }
}

function tokens(list: Token[], options: BodyOptions): Child[] {
  return list.map((token) => renderToken(token, options));
}

export function renderBlocks(blocks: Block[], options: BodyOptions): HTMLElement {
  const body = h('div', { class: 'm-body' });
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
        body.append(h('p', {}, ...tokens(block.tokens, options)));
        break;
      case 'quote':
        body.append(h('blockquote', {}, ...tokens(block.tokens, options)));
        break;
      case 'list':
        body.append(h(block.ordered ? 'ol' : 'ul', {}, ...block.items.map((item) => h('li', {}, ...tokens(item, options)))));
        break;
      case 'code':
        body.append(h('pre', {}, h('code', {}, block.text)));
        break;
    }
  }
  return body;
}

/** Plain text of a body (screen-reader announcements and the switcher), at most `max` characters. */
export function plainText(blocks: Block[] | null, max = 140): string {
  if (blocks === null) return '';
  const parts: string[] = [];
  const token = (item: Token) => {
    if (item.type === 'text' || item.type === 'code') parts.push(item.text);
    else if (item.type === 'mention') parts.push(`@${item.name}`);
    else if (item.type === 'link') parts.push(item.text);
    else if (item.type === 'reference') parts.push(item.visible ? item.title : item.text);
    else parts.push(' ');
  };
  for (const block of blocks) {
    if (block.type === 'code') parts.push(block.text);
    else if (block.type === 'list') block.items.forEach((item) => item.forEach(token));
    else block.tokens.forEach(token);
    parts.push(' ');
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
