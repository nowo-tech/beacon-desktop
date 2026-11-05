import type { PoseId } from '../lib/messages/types';
import { h, patch, type Child } from './dom';
import { icon } from './icons';
import { art, MOMENTS, poseArt, type Moment } from './mascot';

/**
 * The "Still there?" prompt and what follows it (paused, time away, resume), as plain data. The main window builds it
 * (`DesktopApp.promptView()`, already translated) and draws it in two places with the same renderer:
 *
 * - in the Tauri app, its own always-on-top window centred on the active monitor (`index.html?window=prompt`, see
 *   src-tauri/src/prompt.rs), which only reports the button pressed back to the main window;
 * - elsewhere (a plain browser, or when that window cannot be opened), a modal inside the main window.
 *
 * The data crosses the IPC boundary, so it holds no functions: buttons name a `PromptAction` and the host decides.
 */
export type PromptAction =
  | 'here'
  | 'meeting-open'
  | 'meeting-cancel'
  | 'meeting-save'
  | 'discard'
  | 'pause'
  | 'resume-now'
  | 'gap-keep'
  | 'gap-reassign'
  | 'gap-discard'
  /** "Reassign": open / close the task picker, search tasks (`query`), save on `taskId`. */
  | 'reassign-open'
  | 'reassign-cancel'
  | 'reassign-search'
  | 'reassign-save'
  | 'resume'
  | 'not-now'
  | 'escape'
  /** "Open TimeTrack" in the prompt window: brings the main window forward; the prompt stays. */
  | 'open-app';

export interface PromptAnswer {
  action: PromptAction;
  /** Meeting note (`meeting-save`). */
  note?: string;
  /** Task the time goes to (`meeting-save` with another task, `gap-reassign`, `reassign-save`). */
  taskId?: string;
  /** Task search of the picker (`reassign-search`); the main window runs it. */
  query?: string;
}

export interface PromptButton {
  kind: 'button';
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'ghost' | 'link';
  action: PromptAction;
  play?: boolean;
  /** `aria-expanded` of a button that opens a form. */
  expanded?: boolean;
  /** Sent with the answer (the quick "Meeting" choice of the picker). */
  taskId?: string;
}

export interface PromptText {
  kind: 'text';
  id?: string;
  text: string;
  tone?: 'muted' | 'small' | 'quip';
  lang?: string;
}

export interface PromptTaskOption {
  id: string;
  title: string;
}

/** "Count it on another task": a select and its button (`gap-reassign` with the chosen task). */
export interface PromptReassign {
  kind: 'reassign';
  label: string;
  options: PromptTaskOption[];
  button: PromptButton;
}

export interface PromptChoices {
  kind: 'choices';
  layout: 'list' | 'row';
  labelledBy?: string;
  items: (PromptButton | PromptText | PromptReassign)[];
}

/** "I was in a meeting / call": optional note and, on a 1.10 server, another task. */
export interface PromptMeeting {
  kind: 'meeting';
  noteLabel: string;
  noteHelp: string;
  noteMax: number;
  countOnLabel: string | null;
  sameTaskLabel: string;
  targets: PromptTaskOption[];
  saveLabel: string;
  cancelLabel: string;
}

/** Time left before the timer pauses, from wall-clock timestamps. `template` holds `{time}` (M:SS). */
export interface PromptCountdown {
  kind: 'countdown';
  askedAt: string;
  totalSeconds: number;
  template: string;
}

/**
 * "Reassign to another task": the quick "Meeting" choice (when there is a meeting-type task), a task search (run by the
 * main window), the pinned / recent tasks and the results as radio buttons, Save and Cancel.
 */
export interface PromptPicker {
  kind: 'picker';
  heading: string;
  meeting: PromptButton | null;
  searchLabel: string;
  searchButton: string;
  query: string;
  /** Result count, "searching…" or an error (polite status). */
  status: string | null;
  options: PromptTaskOption[];
  selected: string | null;
  emptyText: string;
  saveLabel: string;
  cancelLabel: string;
}

export type PromptBlock = PromptText | PromptChoices | PromptMeeting | PromptCountdown | PromptPicker;

export interface PromptView {
  /** Card id (`idle`, `idle-away`, `gap`, `gap-resume-card`): tests, focus and styles rely on it. */
  id: string;
  moment: Moment;
  /** Friendly-message pose; `null` draws the moment's own pose. */
  pose: PoseId | null;
  title: string;
  blocks: PromptBlock[];
  /** Window title of the prompt window and its document language. */
  windowTitle: string;
  lang: string;
  theme: 'light' | 'dark' | null;
  /** Said (politely) when Esc is pressed: the prompt needs an answer and Esc does not dismiss it. */
  escapeHint: string;
  /** "Open TimeTrack" link (prompt window only; `null` in the in-app modal). */
  openApp: string | null;
  /** Element to focus after this update (`focusSeq` changes each time the host asks for it). */
  focus: string | null;
  focusSeq: number;
}

export interface RenderedPrompt {
  element: HTMLElement;
  /** Updates the countdown to the current time (the same view drawn again). */
  refresh(): void;
  /** Stops the countdown ticker. */
  dispose(): void;
}

export interface PromptOptions {
  onAnswer(answer: PromptAnswer): void;
  /** The countdown reached 0 (the in-app host runs its check at once; the prompt window waits for the main window). */
  onExpired?(): void;
  now?: () => Date;
}

/** M:SS of the seconds left. */
export function clock(seconds: number): string {
  const left = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** Seconds left of a countdown at `now`. */
export function secondsLeft(countdown: Pick<PromptCountdown, 'askedAt' | 'totalSeconds'>, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(countdown.askedAt) + countdown.totalSeconds * 1000 - now.getTime()) / 1000));
}

function button(item: PromptButton, answer: (answer: PromptAnswer) => void): HTMLElement {
  return h(
    'button',
    {
      class: item.style,
      id: item.id,
      key: item.id,
      attrs: { type: 'button', 'aria-expanded': item.expanded === undefined ? undefined : String(item.expanded) },
      on: { click: () => answer({ action: item.action, ...(item.taskId !== undefined ? { taskId: item.taskId } : {}) }) },
    },
    item.play === true && icon('play'),
    item.label,
  );
}

function picker(item: PromptPicker, answer: (answer: PromptAnswer) => void): HTMLElement {
  const search = h('input', { id: 'reassign-search', attrs: { type: 'search', autocomplete: 'off', spellcheck: 'false', maxlength: '200', 'aria-describedby': 'reassign-status' } });
  search.value = item.query;
  const selected = item.selected ?? item.options[0]?.id ?? null;
  const radios = item.options.map((option, index) => {
    const id = `reassign-option-${index}`;
    const radio = h('input', { id, key: `reassign-${option.id}`, attrs: { type: 'radio', name: 'reassign-task', value: option.id } });
    radio.checked = option.id === selected;
    return h('label', { class: 'reassign-option', attrs: { for: id } }, radio, h('span', {}, option.title));
  });
  const chosen = () => radios.map((label) => label.querySelector('input')).find((radio) => radio?.checked)?.value;
  return h(
    'div',
    { class: 'reassign', id: 'reassign-picker' },
    h('p', { class: 'reassign-heading', id: 'reassign-heading' }, item.heading),
    item.meeting !== null && button(item.meeting, answer),
    h(
      'form',
      {
        class: 'reassign-search',
        id: 'reassign-search-form',
        attrs: { role: 'search' },
        on: {
          submit: (event) => {
            event.preventDefault();
            answer({ action: 'reassign-search', query: search.value.trim() });
          },
        },
      },
      h('label', { attrs: { for: 'reassign-search' } }, item.searchLabel),
      h('div', { class: 'reassign-search-row' }, search, h('button', { class: 'secondary small', id: 'reassign-search-go', key: 'reassign-search-go', attrs: { type: 'submit' } }, item.searchButton)),
    ),
    h('p', { class: 'muted small-print', id: 'reassign-status', attrs: { role: 'status', 'aria-live': 'polite' } }, item.status ?? ''),
    radios.length > 0
      ? h('fieldset', { class: 'reassign-options', id: 'reassign-options' }, h('legend', { class: 'sr-only' }, item.heading), ...radios)
      : h('p', { class: 'muted', id: 'reassign-empty' }, item.emptyText),
    h(
      'div',
      { class: 'row-actions' },
      radios.length > 0 &&
        h(
          'button',
          {
            class: 'primary small',
            id: 'reassign-save',
            key: 'reassign-save',
            attrs: { type: 'button' },
            on: {
              click: () => {
                const taskId = chosen();
                if (taskId !== undefined) answer({ action: 'reassign-save', taskId });
              },
            },
          },
          item.saveLabel,
        ),
      h('button', { class: 'link', id: 'reassign-cancel', key: 'reassign-cancel', attrs: { type: 'button' }, on: { click: () => answer({ action: 'reassign-cancel' }) } }, item.cancelLabel),
    ),
  );
}

function text(item: PromptText): HTMLElement {
  const cls = item.tone === 'muted' ? 'muted' : item.tone === 'small' ? 'muted small-print' : item.tone === 'quip' ? 'idle-quip' : undefined;
  return h('p', { class: cls, id: item.id, attrs: { lang: item.lang } }, item.text);
}

/**
 * Draws the prompt card. The same DOM in both hosts (ids as in 0.4: `#idle-here`, `#idle-note`, `#gap-task` …), with
 * `role="dialog"` and `aria-modal`; Esc is swallowed (never a silent dismissal) and says that an answer is needed.
 */
export function renderPrompt(view: PromptView, options: PromptOptions): RenderedPrompt {
  const now = options.now ?? (() => new Date());
  const answer = options.onAnswer;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let refresh = (): void => undefined;
  const hint = h('p', { class: 'sr-only', id: 'prompt-escape-hint', attrs: { role: 'status', 'aria-live': 'polite' } });

  const block = (item: PromptBlock): Child => {
    switch (item.kind) {
      case 'text':
        return text(item);
      case 'choices':
        return h(
          'div',
          { class: item.layout === 'row' ? 'row-actions' : 'choice-list', attrs: { role: item.labelledBy !== undefined ? 'group' : undefined, 'aria-labelledby': item.labelledBy } },
          ...item.items.map((choice): Child => {
            if (choice.kind === 'button') return button(choice, answer);
            if (choice.kind === 'text') return text(choice);
            const select = h('select', { id: 'gap-task' }, ...choice.options.map((option) => h('option', { attrs: { value: option.id } }, option.title)));
            return h(
              'div',
              { class: 'gap-other' },
              h('label', { attrs: { for: 'gap-task' } }, choice.label),
              select,
              h(
                'button',
                { class: choice.button.style, id: choice.button.id, key: choice.button.id, attrs: { type: 'button' }, on: { click: () => answer({ action: 'gap-reassign', taskId: select.value }) } },
                choice.button.label,
              ),
            );
          }),
        );
      case 'meeting': {
        const note = h('input', { id: 'idle-note', attrs: { type: 'text', maxlength: String(item.noteMax), autocomplete: 'off', 'aria-describedby': 'idle-note-help' } });
        const target = h('select', { id: 'idle-target' });
        if (item.countOnLabel !== null) {
          target.append(h('option', { attrs: { value: '' } }, item.sameTaskLabel));
          for (const option of item.targets) target.append(h('option', { attrs: { value: option.id } }, option.title));
        }
        return h(
          'form',
          {
            class: 'meeting',
            id: 'idle-meeting-form',
            on: {
              submit: (event) => {
                event.preventDefault();
                answer({ action: 'meeting-save', note: note.value, ...(item.countOnLabel !== null && target.value !== '' ? { taskId: target.value } : {}) });
              },
            },
          },
          h('label', { attrs: { for: 'idle-note' } }, item.noteLabel),
          note,
          h('p', { class: 'help', id: 'idle-note-help' }, item.noteHelp),
          item.countOnLabel !== null && h('label', { attrs: { for: 'idle-target' } }, item.countOnLabel),
          item.countOnLabel !== null && target,
          h(
            'div',
            { class: 'row-actions' },
            h('button', { class: 'primary small', id: 'idle-meeting-save', key: 'idle-meeting-save', attrs: { type: 'submit' } }, item.saveLabel),
            h('button', { class: 'link', id: 'idle-meeting-cancel', key: 'idle-meeting-cancel', attrs: { type: 'button' }, on: { click: () => answer({ action: 'meeting-cancel' }) } }, item.cancelLabel),
          ),
        );
      }
      case 'picker':
        return picker(item, answer);
      case 'countdown': {
        const label = h('p', { class: 'muted', id: 'idle-countdown-text' });
        const fill = h('span', { class: 'countdown-fill', id: 'idle-countdown-fill' });
        const bar = h(
          'div',
          { class: 'countdown-track', attrs: { role: 'progressbar', 'aria-labelledby': 'idle-countdown-text', 'aria-valuemin': '0', 'aria-valuemax': String(item.totalSeconds) } },
          fill,
        );
        const update = (): number => {
          const left = secondsLeft(item, now());
          label.textContent = item.template.replace('{time}', clock(left));
          bar.setAttribute('aria-valuenow', String(left));
          fill.style.transform = `scaleX(${item.totalSeconds > 0 ? left / item.totalSeconds : 0})`;
          return left;
        };
        update();
        refresh = () => void update();
        // Updated every second without re-rendering; at 0 the host is told once.
        ticker = setInterval(() => {
          if (update() > 0) return;
          if (ticker !== null) clearInterval(ticker);
          ticker = null;
          options.onExpired?.();
        }, 1000);
        return h('div', { class: 'idle-countdown', id: 'idle-countdown' }, label, bar);
      }
    }
  };

  const picture = view.pose !== null ? poseArt(view.pose, 'mascot tiny') : art(MOMENTS[view.moment].pose, '', 'mascot tiny');
  if (view.pose === null) picture.setAttribute('data-moment', view.moment);
  const element = h(
    'section',
    {
      class: 'card still-there',
      id: view.id,
      key: view.id,
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${view.id}-title`, 'data-moment': view.moment },
      on: {
        keydown: (event) => {
          if (event.key !== 'Escape') return;
          // Never a silent dismissal: keep the prompt, say why, and put the focus on the first answer.
          event.preventDefault();
          event.stopPropagation();
          hint.textContent = '';
          hint.textContent = view.escapeHint;
          element.querySelector<HTMLElement>('button, select, input')?.focus();
          answer({ action: 'escape' });
        },
      },
    },
    picture,
    h(
      'div',
      { class: 'still-there-body' },
      h('h2', { id: `${view.id}-title` }, view.title),
      ...view.blocks.map(block),
      typeof view.openApp === 'string' && h('button', { class: 'link prompt-open-app', id: 'prompt-open-app', key: 'prompt-open-app', attrs: { type: 'button' }, on: { click: () => answer({ action: 'open-app' }) } }, view.openApp),
      hint,
    ),
  );
  return {
    element,
    refresh: () => refresh(),
    dispose: () => {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
    },
  };
}

/**
 * Keeps a rendered prompt in `region`: re-renders on each new view (focus kept by `patch`), focuses the first answer
 * when the prompt appears and the element the view asks for when `focusSeq` changes.
 */
export class PromptMount {
  private current: RenderedPrompt | null = null;
  private focusSeq = -1;
  /** The view drawn last: the same content again is not redrawn (a typed search or a chosen task stays). */
  private shownKey = '';

  constructor(
    private readonly region: HTMLElement,
    private readonly options: PromptOptions,
  ) {}

  show(view: PromptView | null): HTMLElement | null {
    const key = view === null ? '' : JSON.stringify(view);
    if (view !== null && key === this.shownKey && this.current !== null && this.region.contains(this.current.element)) {
      this.current.refresh();
      return this.current.element;
    }
    this.shownKey = key;
    this.current?.dispose();
    this.current = null;
    if (view === null) {
      patch(this.region, []);
      this.focusSeq = -1;
      return null;
    }
    const opening = this.region.childElementCount === 0;
    this.current = renderPrompt(view, this.options);
    patch(this.region, [this.current.element]);
    const active = document.activeElement;
    if (view.focus !== null && view.focusSeq !== this.focusSeq) {
      this.region.querySelector<HTMLElement>(`[id="${CSS.escape(view.focus)}"]`)?.focus();
    } else if (opening || active === null || !this.region.contains(active)) {
      this.region.querySelector<HTMLElement>('button, select, input, textarea')?.focus();
    }
    this.focusSeq = view.focusSeq;
    return this.current.element;
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
    this.shownKey = '';
  }
}
