import type { Task } from '../api/types';
import type { MessageKey, Translate } from '../lib/i18n';
import { appName, MEETING_APPS, type MeetingApp, type MeetingNote, type MicSignal, MIN_CALL_CHOICES, type TaskRef } from '../lib/meetings';
import type { MeetingAction } from '../lib/messages/types';
import type { MessageLocale } from '../lib/friendly';
import { h } from './dom';
import { icon } from './icons';
import { poseArt } from './mascot';
import { toastAction, toastActions } from './toast';

/** "Choose task" inside the question: for this meeting (`task`) or to set the generic meeting once (`generic`). */
export type PickerMode = 'task' | 'generic';

export interface MeetingToastProps {
  t: Translate;
  note: MeetingNote;
  picker: PickerMode | null;
  query: string;
  /** Without a query: meeting-like tasks first, then pinned and recent. With one: matches among the known tasks. */
  tasks: Task[];
  isMeeting(task: Task): boolean;
  onAction(action: MeetingAction): void;
  onPick(task: Task): void;
  onQuery(query: string): void;
  onCancelPicker(): void;
  onDismiss(): void;
}

/**
 * The meeting question as a toast: the line, every answer as a button and, after "Choose task" (or "Generic meeting"
 * with none set yet), a short task list with a search field. Never takes focus by itself.
 */
export function renderMeetingToast(props: MeetingToastProps): HTMLElement {
  const { t, note } = props;
  const actions = toastActions(
    'meeting-actions',
    ...note.actions.map((action, index) => {
      const id = `meeting-${action}`;
      const attrs = { 'data-action': action, 'aria-expanded': action === 'choose' ? String(props.picker === 'task') : undefined };
      const click = () => props.onAction(action);
      // The first answer is the toast's button; the others are links next to it.
      return index === 0
        ? toastAction(id, note.labels[action], note.locale, click, attrs)
        : h('button', { class: 'link toast-link', id, key: id, attrs: { type: 'button', lang: note.locale, ...attrs }, on: { click } }, note.labels[action]);
    }),
  );
  return h(
    'section',
    { class: 'toast meeting-toast', id: 'meeting', key: 'meeting', attrs: { 'aria-label': t('meetingToastLabel'), 'data-kind': note.kind } },
    poseArt(note.pose, 'toast-art'),
    h(
      'div',
      { class: 'toast-body' },
      h('p', { class: 'toast-text', id: 'meeting-text', attrs: { lang: note.locale } }, note.text),
      props.picker === null ? actions : renderPicker(props),
    ),
    h('button', { class: 'icon-button toast-close', id: 'meeting-dismiss', key: 'meeting-dismiss', attrs: { type: 'button', 'aria-label': t('toastDismiss'), title: t('toastDismiss') }, on: { click: props.onDismiss } }, icon('close')),
  );
}

function renderPicker(props: MeetingToastProps): HTMLElement {
  const { t } = props;
  const search = h('input', { id: 'meeting-search', key: 'meeting-search', attrs: { type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: t('meetingSearchPlaceholder'), 'aria-label': t('meetingSearch'), 'aria-controls': 'meeting-tasks' } });
  search.value = props.query;
  search.addEventListener('input', () => props.onQuery(search.value));
  return h(
    'div',
    { class: 'meeting-picker', id: 'meeting-picker' },
    props.picker === 'generic' && h('p', { class: 'help', id: 'meeting-generic-help' }, t('meetingGenericOnce')),
    search,
    props.tasks.length === 0
      ? h('p', { class: 'muted', id: 'meeting-tasks-empty' }, t(props.query.trim() === '' ? 'meetingNoTasks' : 'meetingNoMatch'))
      : h(
          'ul',
          { class: 'plain meeting-tasks', id: 'meeting-tasks' },
          ...props.tasks.map((task) =>
            h(
              'li',
              {},
              h(
                'button',
                { class: 'link meeting-task', id: `meeting-task-${task.id}`, key: `meeting-task-${task.id}`, attrs: { type: 'button', 'data-task-id': task.id }, on: { click: () => props.onPick(task) } },
                task.title,
              ),
              props.isMeeting(task) && h('span', { class: 'source-badge meeting-badge' }, t('meetingBadge')),
            ),
          ),
        ),
    h('button', { class: 'link', id: 'meeting-picker-cancel', key: 'meeting-picker-cancel', attrs: { type: 'button' }, on: { click: props.onCancelPicker } }, t('cancel')),
  );
}

export interface MeetingSettingsProps {
  t: Translate;
  enabled: boolean;
  consent: { granted: boolean; date: string } | null;
  minMinutes: number;
  generic: TaskRef | null;
  /** Tasks offered as the generic meeting (meeting-like first). */
  candidates: Task[];
  muted: readonly MeetingApp[];
  signal: MicSignal | null;
  locale: MessageLocale;
  onToggle(on: boolean): void;
  onMinMinutes(minutes: number): void;
  onGeneric(task: TaskRef | null): void;
  onUnmute(app: MeetingApp): void;
}

/** What the last microphone check found ("Now: the microphone is in use (Teams)."), for Settings. */
export function meetingStatus(t: Translate, signal: MicSignal | null, locale: MessageLocale): string {
  const key: MessageKey = signal === null ? 'meetingStatusWaiting' : signal.source === 'unavailable' ? 'meetingStatusUnavailable' : signal.apps.length > 0 ? 'meetingStatusApps' : signal.inUse ? 'meetingStatusOther' : 'meetingStatusFree';
  return t(key, { apps: signal?.apps.map((app) => appName(app, locale)).join(', ') ?? '' });
}

/** Settings → Meetings: the opt-in switch and what it reads, then (when on) the wait, the generic meeting and muted apps. */
export function renderMeetingSettings(props: MeetingSettingsProps): HTMLElement {
  const { t } = props;
  const toggle = h('input', { id: 'feature-meetingDetection', attrs: { type: 'checkbox', 'aria-describedby': 'meeting-help meeting-privacy' } });
  toggle.checked = props.enabled;
  toggle.addEventListener('change', () => props.onToggle(toggle.checked));
  return h(
    'section',
    { class: 'feature', id: 'meeting-settings', attrs: { 'aria-labelledby': 'meeting-title' } },
    h('h2', { id: 'meeting-title' }, t('meetingTitle')),
    h('label', { class: 'switch' }, toggle, t('meetingToggle')),
    h('p', { class: 'help', id: 'meeting-help' }, t('meetingHelp')),
    h('p', { class: 'help', id: 'meeting-privacy' }, t('meetingPrivacy')),
    props.enabled && renderOptions(props),
    props.consent !== null && h('p', { class: 'muted', id: 'consent-meetingDetection' }, t(props.consent.granted ? 'consentGiven' : 'consentWithdrawn', { date: props.consent.date })),
  );
}

function renderOptions(props: MeetingSettingsProps): HTMLElement {
  const { t } = props;
  const wait = h('select', { id: 'meeting-min' });
  for (const minutes of MIN_CALL_CHOICES) {
    const option = h('option', { attrs: { value: String(minutes) } }, t('meetingMinChoice', { minutes }));
    option.selected = minutes === props.minMinutes;
    wait.append(option);
  }
  wait.addEventListener('change', () => props.onMinMinutes(Number(wait.value)));
  const generic = h('select', { id: 'meeting-generic', attrs: { 'aria-describedby': 'meeting-generic-text' } });
  const choices: TaskRef[] = [...(props.generic !== null ? [props.generic] : []), ...props.candidates.filter((task) => task.id !== props.generic?.id)];
  generic.append(h('option', { attrs: { value: '' } }, t('meetingGenericNone')));
  for (const task of choices) {
    const option = h('option', { attrs: { value: task.id } }, task.title);
    option.selected = task.id === props.generic?.id;
    generic.append(option);
  }
  generic.addEventListener('change', () => {
    const task = choices.find((item) => item.id === generic.value);
    props.onGeneric(task !== undefined ? { id: task.id, title: task.title } : null);
  });
  return h(
    'div',
    { class: 'meeting-options' },
    h('label', { class: 'inline' }, t('meetingMin'), wait),
    h('label', { class: 'inline' }, t('meetingGeneric'), generic),
    h('p', { class: 'help', id: 'meeting-generic-text' }, t('meetingGenericHelp')),
    props.muted.length > 0 &&
      h(
        'div',
        { id: 'meeting-muted' },
        h('p', { class: 'help' }, t('meetingMutedTitle')),
        h(
          'ul',
          { class: 'plain meeting-muted-list' },
          ...MEETING_APPS.filter((app) => props.muted.includes(app)).map((app) =>
            h(
              'li',
              { attrs: { 'data-app': app } },
              h('span', {}, appName(app, props.locale)),
              ' ',
              h('button', { class: 'link', id: `meeting-unmute-${app}`, key: `meeting-unmute-${app}`, attrs: { type: 'button' }, on: { click: () => props.onUnmute(app) } }, t('meetingUnmute')),
            ),
          ),
        ),
      ),
    h('p', { class: 'muted', id: 'meeting-status', attrs: { 'aria-live': 'off' } }, meetingStatus(t, props.signal, props.locale)),
  );
}
