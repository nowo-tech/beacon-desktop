import type { Task } from '../api/types';
import type { Translate } from '../lib/i18n';
import type { MessageLocale } from '../lib/friendly';
import { type KeyedMeeting, LEAD_PRESETS, MAX_CUSTOM_LEAD, type MeetingNote, type MeetingSupport, meetingTitle, MIN_CUSTOM_LEAD, type ReminderSettings, shortKey, type SnoozeChoice } from '../lib/meetingReminders';
import { MEETING_REMINDERS } from '../lib/messages/meetingReminders';
import { h } from './dom';
import { icon } from './icons';
import { poseArt } from './mascot';

/** Settings → Meeting reminders (contract §23.1 / §23.2). */
export interface ReminderSettingsProps {
  t: Translate;
  support: MeetingSupport;
  /** Polling stopped by a 403 (re-consent) or a 404 (turned off) since the last `GET me`. */
  stopped: 'scope' | 'off' | null;
  enabled: boolean;
  settings: ReminderSettings;
  /** The OS refused desktop notifications (reminders then use the window). */
  notificationsOff: boolean;
  /** "Custom…" lead time chosen, even before a value was typed. */
  customLead: boolean;
  leadError: boolean;
  onToggle(on: boolean): void;
  onLead(minutes: number): void;
  onCustomLead(): void;
  onSetting(patch: Partial<Pick<ReminderSettings, 'meetingOutsideHours' | 'meetingDaysOff' | 'meetingAskOnStart' | 'meetingAutoPause'>>): void;
  onConsent(): void;
  onOpenCalendars(url: string): void;
}

const CUSTOM = 'custom';

function checkbox(id: string, label: string, checked: boolean, onChange: (on: boolean) => void, describedBy?: string): HTMLElement {
  const input = h('input', { id, attrs: { type: 'checkbox', 'aria-describedby': describedBy } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, label);
}

/** Why the reminders cannot run (and what to do), or `null` when they can. */
function availability(props: ReminderSettingsProps): HTMLElement | null {
  const { t, support } = props;
  const calendars = support.kind === 'unsupported' ? null : support.calendarsUrl;
  const open = (id: string, label: string) =>
    calendars !== null && h('button', { class: 'secondary small', id, key: id, attrs: { type: 'button' }, on: { click: () => props.onOpenCalendars(calendars) } }, label);
  if (support.kind === 'unsupported' || props.stopped === 'off') return h('p', { class: 'muted', id: 'meeting-reminders-unavailable' }, t(support.kind === 'unsupported' ? 'meetingRemindersUnsupported' : 'meetingRemindersOff'));
  if (support.kind === 'consent' || props.stopped === 'scope') {
    return h(
      'div',
      { id: 'meeting-reminders-consent-block' },
      h('p', { class: 'help', id: 'meeting-reminders-consent-text' }, t('meetingRemindersConsent')),
      h('button', { class: 'primary small', id: 'meeting-reminders-consent', key: 'meeting-reminders-consent', attrs: { type: 'button', 'aria-describedby': 'meeting-reminders-consent-text' }, on: { click: props.onConsent } }, t('meetingRemindersConsentButton')),
    );
  }
  if (support.status === 'not_connected') return h('div', { id: 'meeting-reminders-connect-block' }, h('p', { class: 'help' }, t('meetingRemindersNotConnected')), open('meeting-reminders-connect', t('meetingRemindersConnect')));
  if (support.status === 'needs_reconnect') return h('div', { id: 'meeting-reminders-reconnect-block' }, h('p', { class: 'help' }, t('meetingRemindersReconnect')), open('meeting-reminders-reconnect', t('meetingRemindersReconnectButton')));
  return null;
}

/** Settings → Meeting reminders: the switch, the lead time (presets or custom 1–120) and the gates. */
export function renderReminderSettings(props: ReminderSettingsProps): HTMLElement {
  const { t } = props;
  const usable = props.support.kind === 'on' && props.stopped === null;
  const toggle = h('input', { id: 'meeting-reminders-toggle', attrs: { type: 'checkbox', 'aria-describedby': 'meeting-reminders-help meeting-reminders-privacy' } });
  toggle.checked = props.enabled;
  toggle.disabled = !usable;
  toggle.addEventListener('change', () => props.onToggle(toggle.checked));
  return h(
    'section',
    { class: 'feature', id: 'meeting-reminders', attrs: { 'aria-labelledby': 'meeting-reminders-title' } },
    h('h2', { id: 'meeting-reminders-title' }, t('meetingRemindersTitle')),
    availability(props),
    h('label', { class: 'switch' }, toggle, t('meetingRemindersToggle')),
    h('p', { class: 'help', id: 'meeting-reminders-help' }, t('meetingRemindersHelp')),
    usable && props.enabled && renderOptions(props),
    props.enabled && props.notificationsOff && h('p', { class: 'muted', id: 'meeting-reminders-notifications-off' }, t('meetingNotificationsOff')),
    h('p', { class: 'help', id: 'meeting-reminders-privacy' }, t('meetingRemindersPrivacy')),
  );
}

function renderOptions(props: ReminderSettingsProps): HTMLElement {
  const { t, settings } = props;
  const lead = settings.meetingLeadMinutes;
  const custom = props.customLead || !LEAD_PRESETS.includes(lead);
  const select = h('select', { id: 'meeting-lead' });
  for (const minutes of LEAD_PRESETS) select.append(h('option', { attrs: { value: String(minutes) } }, minutes === 0 ? t('meetingLeadOff') : t('meetingLeadChoice', { minutes })));
  select.append(h('option', { attrs: { value: CUSTOM } }, t('meetingLeadCustom')));
  select.value = custom ? CUSTOM : String(lead);
  select.addEventListener('change', () => (select.value === CUSTOM ? props.onCustomLead() : props.onLead(Number(select.value))));
  const input = h('input', {
    id: 'meeting-lead-custom',
    key: 'meeting-lead-custom',
    attrs: { type: 'number', min: String(MIN_CUSTOM_LEAD), max: String(MAX_CUSTOM_LEAD), step: '1', inputmode: 'numeric', 'aria-invalid': props.leadError ? 'true' : undefined, 'aria-describedby': props.leadError ? 'meeting-lead-error' : undefined },
  });
  input.value = custom && lead > 0 ? String(lead) : '';
  input.addEventListener('change', () => props.onLead(input.value.trim() === '' ? Number.NaN : Number(input.value)));
  return h(
    'div',
    { class: 'meeting-options', id: 'meeting-reminders-options' },
    h('label', { class: 'inline' }, t('meetingLead'), select),
    custom && h('label', { class: 'inline' }, t('meetingLeadCustomLabel'), input),
    props.leadError && h('p', { class: 'field-error', id: 'meeting-lead-error' }, t('meetingLeadInvalid')),
    checkbox('meeting-outside-hours', t('meetingOutsideHours'), settings.meetingOutsideHours, (on) => props.onSetting({ meetingOutsideHours: on })),
    checkbox('meeting-days-off', t('meetingDaysOffToggle'), settings.meetingDaysOff, (on) => props.onSetting({ meetingDaysOff: on })),
    checkbox('meeting-ask-start', t('meetingAskStart'), settings.meetingAskOnStart, (on) => props.onSetting({ meetingAskOnStart: on })),
    checkbox('meeting-auto-pause', t('meetingAutoPause'), settings.meetingAutoPause, (on) => props.onSetting({ meetingAutoPause: on })),
    h('p', { class: 'help', id: 'meeting-private-busy' }, t('meetingPrivateBusy')),
  );
}

/** *Today*: the remaining meetings of the day with their times and *Join*. */
export interface TodayProps {
  t: Translate;
  locale: MessageLocale;
  meetings: KeyedMeeting[];
  now: number;
  time(at: number): string;
  /** "Last updated at 09:12: this list may be outdated." (the list is older than an hour), or null. */
  outdated: string | null;
  onJoin(meeting: KeyedMeeting): void;
}

export function renderTodayMeetings(props: TodayProps): HTMLElement {
  const { t } = props;
  return h(
    'section',
    { class: 'card meetings-today', id: 'meetings-today', attrs: { 'aria-labelledby': 'meetings-today-title' } },
    h('h2', { class: 'section-title', id: 'meetings-today-title' }, t('meetingsTodayTitle')),
    props.meetings.length === 0
      ? h('p', { class: 'muted', id: 'meetings-today-empty' }, t('meetingsTodayEmpty'))
      : h(
          'ul',
          { class: 'plain meetings-today-list', id: 'meetings-today-list', attrs: { 'aria-labelledby': 'meetings-today-title' } },
          ...props.meetings.map((meeting) => {
            const title = meetingTitle(meeting, props.locale);
            const now = meeting.start <= props.now;
            return h(
              'li',
              { class: meeting.private ? 'meeting-row busy' : 'meeting-row', attrs: { 'data-key': shortKey(meeting.key) } },
              h('span', { class: 'meeting-time' }, now ? t('meetingsTodayNow') : props.time(meeting.start), '–', props.time(meeting.end)),
              ' ',
              h('span', { class: 'meeting-title', attrs: { lang: meeting.title === null ? props.locale : undefined } }, title),
              meeting.joinUrl !== null &&
                h(
                  'button',
                  { class: 'secondary small meeting-join', id: `meeting-join-${shortKey(meeting.key)}`, key: `meeting-join-${shortKey(meeting.key)}`, attrs: { type: 'button', 'aria-label': t('meetingJoinLabel', { meeting: title }) }, on: { click: () => props.onJoin(meeting) } },
                  t('meetingJoin'),
                ),
            );
          }),
        ),
    props.outdated !== null && h('p', { class: 'muted', id: 'meetings-today-outdated' }, props.outdated),
  );
}

/** The reminder (or start prompt) inside the window: every choice, and the task picker of *Track the meeting*. */
export interface ReminderToastProps {
  t: Translate;
  note: MeetingNote;
  /** The meeting has a *Join* link. */
  joinable: boolean;
  snoozes: SnoozeChoice[];
  /** *Track the meeting* without a linked task: pick one. */
  picker: { query: string; tasks: Task[] } | null;
  onJoin(): void;
  onSnooze(choice: SnoozeChoice): void;
  onKeep(): void;
  onPause(): void;
  onTrack(): void;
  onUndo(): void;
  onPick(task: Task): void;
  onQuery(query: string): void;
  onDismiss(): void;
}

export function renderReminderToast(props: ReminderToastProps): HTMLElement {
  const { t, note } = props;
  const labels = MEETING_REMINDERS[note.locale].actions;
  const button = (id: string, label: string, onClick: () => void, primary = false) =>
    h('button', { class: primary ? 'secondary small toast-action' : 'link toast-link', id, key: id, attrs: { type: 'button', lang: note.locale }, on: { click: onClick } }, label);
  const snoozeLabel: Record<string, string> = { default: labels.snooze, 1: labels.snooze1, 5: labels.snooze5 };
  const actions =
    note.kind === 'reminder'
      ? [
          props.joinable && button('meeting-reminder-join', labels.join, props.onJoin, true),
          ...props.snoozes.map((choice) => button(`meeting-reminder-snooze-${choice}`, snoozeLabel[String(choice)] as string, () => props.onSnooze(choice), !props.joinable && choice === 'default')),
        ]
      : note.kind === 'start'
        ? [button('meeting-reminder-track', labels.track, props.onTrack, true), button('meeting-reminder-pause', labels.pause, props.onPause), button('meeting-reminder-keep', labels.keep, props.onKeep)]
        : note.kind === 'paused'
          ? [button('meeting-reminder-undo', labels.undo, props.onUndo, true)]
          : [];
  const search = h('input', { id: 'meeting-reminder-search', key: 'meeting-reminder-search', attrs: { type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: t('meetingSearchPlaceholder'), 'aria-label': t('meetingSearch') } });
  search.value = props.picker?.query ?? '';
  search.addEventListener('input', () => props.onQuery(search.value));
  const picker =
    props.picker !== null &&
    h(
      'div',
      { class: 'meeting-picker', id: 'meeting-reminder-picker' },
      h('p', { class: 'help' }, t('meetingTrackPick')),
      search,
      props.picker.tasks.length === 0
        ? h('p', { class: 'muted', id: 'meeting-reminder-tasks-empty' }, t(props.picker.query.trim() === '' ? 'meetingNoTasks' : 'meetingNoMatch'))
        : h(
            'ul',
            { class: 'plain meeting-tasks', id: 'meeting-reminder-tasks' },
            ...props.picker.tasks.map((task) => h('li', {}, h('button', { class: 'link meeting-task', id: `meeting-reminder-task-${task.id}`, key: `meeting-reminder-task-${task.id}`, attrs: { type: 'button' }, on: { click: () => props.onPick(task) } }, task.title))),
          ),
    );
  return h(
    'section',
    { class: 'toast meeting-toast', id: 'meeting-reminder', key: 'meeting-reminder', attrs: { 'aria-label': t('meetingReminderLabel'), 'data-kind': note.kind } },
    poseArt(note.pose, 'toast-art'),
    h(
      'div',
      { class: 'toast-body' },
      h('p', { class: 'toast-text', id: 'meeting-reminder-title', attrs: { lang: note.locale } }, h('strong', {}, note.title)),
      h('p', { class: 'toast-text', id: 'meeting-reminder-text', attrs: { lang: note.locale } }, note.body),
      picker || h('div', { class: 'toast-actions', id: 'meeting-reminder-actions' }, ...actions),
    ),
    h('button', { class: 'icon-button toast-close', id: 'meeting-reminder-dismiss', key: 'meeting-reminder-dismiss', attrs: { type: 'button', 'aria-label': t('toastDismiss'), title: t('toastDismiss') }, on: { click: props.onDismiss } }, icon('close')),
  );
}
