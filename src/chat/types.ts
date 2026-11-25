/**
 * ChatKit client API v1 (ChatKitBundle 2.4.0, `docs/API.md`, `docs/openapi/chat-client-v1.yaml`): the shapes the app
 * reads, and parsers that check every field. Anything malformed is dropped or replaced by a safe default, so a server
 * answer can never put a non-string where the UI expects text, or a URL scheme the app would open.
 */

export type ConversationKind = 'direct' | 'channel' | 'support';

export interface Person {
  uuid: string | null;
  name: string;
  initials: string;
  bot: boolean;
}

export interface Context {
  key: string;
  label: string;
}

export interface ChatMe {
  user: Person;
  scopes: string[];
  context: string | null;
  contexts: Context[];
  features: { realtime: boolean; realtimeEvents: 'full' | 'ids' | null; send: boolean; search: boolean; attachments: boolean };
  limits: { conversationsPageMax: number; messagesPageMax: number };
}

export interface Conversation {
  uuid: string;
  kind: ConversationKind;
  title: string;
  subtitle: string;
  initials: string;
  channelKey: string | null;
  peerStatus: string | null;
  unread: number;
  archived: boolean;
  mutedUntil: string | null;
  lastMessageAt: string;
  lastMessageId: number | null;
  preview: string | null;
  ticketStatus: string | null;
  membersCount?: number;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export type Mark = 'bold' | 'italic' | 'strike';

export type Token =
  | { type: 'text'; text: string; marks: Mark[] }
  | { type: 'break' }
  | { type: 'code'; text: string }
  | { type: 'mention'; userUuid: string | null; name: string }
  | { type: 'link'; url: string | null; text: string; card: boolean }
  | {
      type: 'reference';
      visible: true;
      refType: string;
      id: string;
      typeLabel: string;
      title: string;
      subtitle: string;
      badge: string;
      tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
      url: string | null;
    }
  | { type: 'reference'; visible: false; text: string };

export type Block =
  | { type: 'paragraph' | 'quote'; tokens: Token[] }
  | { type: 'list'; ordered: boolean; items: Token[][] }
  | { type: 'code'; text: string };

export interface Message {
  id: number;
  uuid: string;
  kind: string;
  author: Person;
  mine: boolean;
  createdAt: string;
  edited: boolean;
  deleted: boolean;
  mentionsMe: boolean;
  threadRootUuid: string | null;
  thread: { count: number; lastReplyAt: string | null } | null;
  reactions: Reaction[];
  /** `null`: deleted (or no body). */
  blocks: Block[] | null;
}

export interface ConversationsPage {
  conversations: Conversation[];
  nextCursor: string | null;
  unreadTotal: number | null;
  unreadTotalCapped: boolean;
}

export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
  readUpTo: number | null;
}

export interface ThreadPage {
  root: Message;
  replies: Message[];
  hasMore: boolean;
  replyCount: number;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const int = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback);
const intOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);
const bool = (value: unknown): boolean => value === true;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ChatKit's context key pattern (`personal`, `org:<uuid>`). */
export const CONTEXT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Initials for an avatar: the server's, else the first letters of the name (never more than 2 characters). */
function initials(raw: unknown, name: string): string {
  const given = str(raw).trim();
  if (given !== '') return [...given].slice(0, 2).join('').toUpperCase();
  return name
    .split(/\s+/)
    .filter((part) => part !== '')
    .map((part) => [...part][0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function parsePerson(raw: unknown): Person {
  const value = isObject(raw) ? raw : {};
  const name = str(value.name).trim() || '?';
  return { uuid: isUuid(value.uuid) ? value.uuid : null, name, initials: initials(value.initials, name), bot: bool(value.bot) };
}

export function parseMe(raw: unknown): ChatMe {
  const value = isObject(raw) ? raw : {};
  const features = isObject(value.features) ? value.features : {};
  const limits = isObject(value.limits) ? value.limits : {};
  const contexts = list(value.contexts)
    .filter(isObject)
    .map((item) => ({ key: str(item.key), label: str(item.label).trim() || str(item.key) }))
    .filter((item) => CONTEXT_KEY.test(item.key));
  const realtimeEvents = features.realtimeEvents === 'ids' || features.realtimeEvents === 'full' ? features.realtimeEvents : null;
  return {
    user: parsePerson(value.user),
    scopes: list(value.scopes).filter((item): item is string => typeof item === 'string'),
    context: typeof value.context === 'string' && CONTEXT_KEY.test(value.context) ? value.context : null,
    contexts,
    features: {
      realtime: bool(features.realtime),
      realtimeEvents,
      send: bool(features.send),
      search: bool(features.search),
      attachments: bool(features.attachments),
    },
    limits: {
      conversationsPageMax: Math.min(Math.max(int(limits.conversationsPageMax, 100), 1), 100),
      messagesPageMax: Math.min(Math.max(int(limits.messagesPageMax, 100), 1), 100),
    },
  };
}

const KINDS: readonly ConversationKind[] = ['direct', 'channel', 'support'];

export function parseConversation(raw: unknown): Conversation | null {
  if (!isObject(raw) || !isUuid(raw.uuid)) return null;
  const kind = KINDS.includes(raw.kind as ConversationKind) ? (raw.kind as ConversationKind) : 'channel';
  const title = str(raw.title).trim() || '…';
  const last = isObject(raw.lastMessage) ? raw.lastMessage : null;
  const ticket = isObject(raw.ticket) ? raw.ticket : null;
  return {
    uuid: raw.uuid.toLowerCase(),
    kind,
    title,
    subtitle: str(raw.subtitle),
    initials: initials(raw.initials, title),
    channelKey: strOrNull(raw.channelKey),
    peerStatus: strOrNull(raw.peerStatus),
    unread: int(raw.unread),
    archived: bool(raw.archived),
    mutedUntil: strOrNull(raw.mutedUntil),
    lastMessageAt: str(raw.lastMessageAt),
    lastMessageId: intOrNull(raw.lastMessageId),
    preview: last !== null && !bool(last.deleted) ? strOrNull(last.preview) : null,
    ticketStatus: ticket !== null ? strOrNull(ticket.statusLabel) : null,
    membersCount: typeof raw.membersCount === 'number' ? int(raw.membersCount) : undefined,
  };
}

export function parseConversationsPage(raw: unknown): ConversationsPage {
  const value = isObject(raw) ? raw : {};
  return {
    conversations: list(value.conversations)
      .map(parseConversation)
      .filter((item): item is Conversation => item !== null),
    nextCursor: strOrNull(value.nextCursor),
    unreadTotal: typeof value.unreadTotal === 'number' ? int(value.unreadTotal) : null,
    unreadTotalCapped: bool(value.unreadTotalCapped),
  };
}

const MARKS: readonly Mark[] = ['bold', 'italic', 'strike'];
const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;

/** `http(s)` and `mailto` only, as an absolute URL (relative ones resolved against `origin`); anything else is `null`. */
export function safeUrl(value: unknown, origin: string): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim(), origin);
  } catch {
    return null;
  }
  if (url.protocol === 'mailto:') return url.href;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

export function parseToken(raw: unknown, origin: string): Token | null {
  if (!isObject(raw)) return null;
  switch (raw.type) {
    case 'text':
      return { type: 'text', text: str(raw.text), marks: list(raw.marks).filter((mark): mark is Mark => MARKS.includes(mark as Mark)) };
    case 'break':
      return { type: 'break' };
    case 'code':
      return { type: 'code', text: str(raw.text) };
    case 'mention':
      return { type: 'mention', userUuid: isUuid(raw.userUuid) ? raw.userUuid : null, name: str(raw.name) };
    case 'link': {
      const url = safeUrl(raw.url, origin);
      return { type: 'link', url, text: str(raw.text) || url || '', card: bool(raw.card) };
    }
    case 'reference':
      if (raw.visible !== true) return { type: 'reference', visible: false, text: str(raw.text) };
      return {
        type: 'reference',
        visible: true,
        refType: str(raw.refType),
        id: str(raw.id),
        typeLabel: str(raw.typeLabel),
        title: str(raw.title),
        subtitle: str(raw.subtitle),
        badge: str(raw.badge),
        tone: TONES.includes(raw.tone as (typeof TONES)[number]) ? (raw.tone as (typeof TONES)[number]) : 'neutral',
        // Relative reference URLs are resolved against the API origin (ChatKit renders Beacon paths).
        url: safeUrl(raw.url, origin),
      };
    default:
      return null;
  }
}

const tokens = (raw: unknown, origin: string): Token[] => list(raw).map((item) => parseToken(item, origin)).filter((item): item is Token => item !== null);

export function parseBlocks(raw: unknown, origin: string): Block[] | null {
  if (!isObject(raw) || raw.format !== 'tokens/1') return null;
  const blocks: Block[] = [];
  for (const block of list(raw.blocks)) {
    if (!isObject(block)) continue;
    if (block.type === 'paragraph' || block.type === 'quote') blocks.push({ type: block.type, tokens: tokens(block.tokens, origin) });
    else if (block.type === 'list') blocks.push({ type: 'list', ordered: bool(block.ordered), items: list(block.items).map((item) => tokens(item, origin)) });
    else if (block.type === 'code') blocks.push({ type: 'code', text: str(block.text) });
  }
  return blocks;
}

export function parseMessage(raw: unknown, origin: string): Message | null {
  if (!isObject(raw) || !isUuid(raw.uuid) || intOrNull(raw.id) === null) return null;
  const thread = isObject(raw.thread) && int(raw.thread.count) > 0 ? { count: int(raw.thread.count), lastReplyAt: strOrNull(raw.thread.lastReplyAt) } : null;
  const deleted = bool(raw.deleted);
  return {
    id: raw.id as number,
    uuid: raw.uuid.toLowerCase(),
    kind: str(raw.kind, 'user'),
    author: parsePerson(raw.author),
    mine: bool(raw.mine),
    createdAt: str(raw.createdAt),
    edited: bool(raw.edited),
    deleted,
    mentionsMe: bool(raw.mentionsMe) || raw.mentionAll === 'channel' || raw.mentionAll === 'here',
    threadRootUuid: isUuid(raw.threadRootUuid) ? raw.threadRootUuid.toLowerCase() : null,
    thread,
    reactions: list(raw.reactions)
      .filter(isObject)
      .map((item) => ({ emoji: str(item.emoji), count: int(item.count), mine: bool(item.mine) }))
      .filter((item) => item.emoji !== '' && [...item.emoji].length <= 16 && item.count > 0),
    blocks: deleted ? null : parseBlocks(raw.body, origin),
  };
}

const messages = (raw: unknown, origin: string): Message[] => list(raw).map((item) => parseMessage(item, origin)).filter((item): item is Message => item !== null);

export function parseMessagesPage(raw: unknown, origin: string): MessagesPage {
  const value = isObject(raw) ? raw : {};
  return { messages: messages(value.messages, origin), hasMore: bool(value.hasMore), readUpTo: intOrNull(value.readUpTo) };
}

export function parseThreadPage(raw: unknown, origin: string): ThreadPage | null {
  const value = isObject(raw) ? raw : {};
  const root = parseMessage(value.root, origin);
  if (root === null) return null;
  const replies = messages(value.replies, origin);
  return { root, replies, hasMore: bool(value.hasMore), replyCount: int(value.replyCount, replies.length) };
}

/** A realtime hint (ids only, from Rust: src-tauri/src/realtime.rs). */
export interface ChatHint {
  kind: 'message' | 'message_updated' | 'thread' | 'read' | 'unread' | 'conversation';
  conversationUuid?: string;
  messageUuid?: string;
  messageId?: number;
  rootUuid?: string;
  deleted?: boolean;
}

const HINT_KINDS: readonly ChatHint['kind'][] = ['message', 'message_updated', 'thread', 'read', 'unread', 'conversation'];

export function parseHint(raw: unknown): ChatHint | null {
  if (!isObject(raw) || !HINT_KINDS.includes(raw.kind as ChatHint['kind'])) return null;
  const hint: ChatHint = { kind: raw.kind as ChatHint['kind'] };
  if (isUuid(raw.conversationUuid)) hint.conversationUuid = raw.conversationUuid.toLowerCase();
  if (isUuid(raw.messageUuid)) hint.messageUuid = raw.messageUuid.toLowerCase();
  if (isUuid(raw.rootUuid)) hint.rootUuid = raw.rootUuid.toLowerCase();
  if (intOrNull(raw.messageId) !== null) hint.messageId = raw.messageId as number;
  if (typeof raw.deleted === 'boolean') hint.deleted = raw.deleted;
  return hint;
}

export type RealtimeMode = 'live' | 'polling' | 'unauthorized' | 'stopped';
