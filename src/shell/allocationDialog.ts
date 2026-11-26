/**
 * Required time fields dialog (owner Q5, BD-3a; prototype "Stop timer" / "Save this entry before switching"): the
 * activity type the organization requires and, when the host offers subjects next to a task, an optional client or
 * subject. One native modal `<dialog>` (top layer, `Esc`, focus return); it answers the allocation to send, or `null`
 * (cancelled: nothing is sent, the timer is left as it was).
 *
 * UX: the rows keep their height in every state (loading, offline, 429, empty), the subject results float under the
 * input (no layout shift), the error of a required field appears only after a submit, and focus goes to the first
 * invalid field (`aria-invalid` / `aria-describedby` set then, never before).
 */
import { ApiError } from '../api/client';
import type { ActivityType, Allocation, Subject } from '../api/types';
import { type AllocationFeatures, allocationOf, groupActivities, type Missing, taskSubjectTypes } from '../lib/allocation';
import { h } from '../ui/dom';
import type { ChatText } from '../chat/i18n';
import { chatIcon } from '../chat/icons';

export type AllocationMode = 'start' | 'stop' | 'switch' | 'context';

export interface AllocationRequest {
  mode: AllocationMode;
  taskTitle: string;
  /** Running time (stop, switch, context): the summary line shows it ticking. */
  startedAt: string | null;
  /** Organization of the timer (label), `null` for Personal or unknown. */
  org: string | null;
  /** `context` mode: the organization the person switches to. */
  target?: string | null;
  missing: Missing;
  features: AllocationFeatures;
  initialActivity: string | null;
  /** The initial activity type came from the task's last one (a hint under the field). */
  inherited?: boolean;
  initialSubject?: Subject | null;
  loadActivities(): Promise<ActivityType[]>;
  searchSubjects(type: string, query: string): Promise<Subject[]>;
}

/** Debounce of the subject search (the server rate-limits it per token). */
export const SEARCH_DELAY_MS = 250;

type LoadState = { kind: 'loading' } | { kind: 'ready'; list: ActivityType[] } | { kind: 'offline' } | { kind: 'limited'; until: number };
type SearchState = { kind: 'idle' } | { kind: 'searching' } | { kind: 'results'; list: Subject[] } | { kind: 'offline' } | { kind: 'limited'; until: number };

function clock(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export class AllocationDialog {
  readonly dialog: HTMLDialogElement;
  private request: AllocationRequest | null = null;
  private resolve: ((value: Allocation | null) => void) | null = null;
  private activity: string | null = null;
  private subject: Subject | null = null;
  private subjectType: string | null = null;
  private load: LoadState = { kind: 'loading' };
  private search: SearchState = { kind: 'idle' };
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private searchSeq = 0;
  private optionIndex = -1;
  private submitted = false;

  constructor(
    private readonly t: ChatText,
    private readonly announce: (text: string) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.dialog = h('dialog', { class: 'sh-dialog alloc-dialog', id: 'alloc-dialog', attrs: { 'aria-labelledby': 'alloc-title' } });
    this.dialog.addEventListener('close', () => this.finish(null));
  }

  get open(): boolean {
    return this.dialog.open;
  }

  /** Shows the dialog; resolves with the allocation (only the fields set), or `null` when cancelled. */
  ask(request: AllocationRequest): Promise<Allocation | null> {
    if (this.resolve !== null) this.finish(null);
    this.request = request;
    this.activity = request.initialActivity;
    this.subject = request.initialSubject ?? null;
    this.subjectType = taskSubjectTypes(request.features)[0]?.type ?? null;
    this.load = request.features.activityTypes || request.missing.activityType ? { kind: 'loading' } : { kind: 'ready', list: [] };
    this.search = { kind: 'idle' };
    this.submitted = false;
    this.optionIndex = -1;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.focusFirst();
    if (this.load.kind === 'loading') void this.loadActivities();
    if (request.startedAt !== null) {
      this.ticker = setInterval(() => {
        const time = this.dialog.querySelector('#alloc-elapsed');
        if (time !== null && this.request?.startedAt) time.textContent = clock(this.request.startedAt, this.now());
      }, 1000);
    }
    return new Promise((resolve) => (this.resolve = resolve));
  }

  private finish(value: Allocation | null): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.ticker = null;
    this.searchTimer = null;
    const resolve = this.resolve;
    this.resolve = null;
    this.request = null;
    resolve?.(value);
  }

  private async loadActivities(): Promise<void> {
    const request = this.request;
    if (request === null) return;
    this.load = { kind: 'loading' };
    this.renderActivity();
    try {
      const list = await request.loadActivities();
      if (this.request !== request) return;
      this.load = { kind: 'ready', list };
      // A remembered type no longer offered is dropped (the server would answer 422 activity_type_inactive).
      if (this.activity !== null && !list.some((item) => item.key === this.activity)) this.activity = null;
    } catch (error) {
      if (this.request !== request) return;
      this.load = error instanceof ApiError && error.status === 429 ? { kind: 'limited', until: this.now() + (error.retryAfter ?? 30) * 1000 } : { kind: 'offline' };
    }
    // Focus waited on Cancel while the list loaded (a disabled select cannot take it): move it to the field now.
    const active = document.activeElement?.id;
    const refocus = active === 'alloc-activity' || (active === 'alloc-cancel' && request.missing.activityType && !this.submitted);
    this.renderActivity();
    const select = this.dialog.querySelector<HTMLSelectElement>('#alloc-activity');
    if (refocus && select !== null && !select.disabled) select.focus();
  }

  // ---- rendering ----------------------------------------------------------------------------------------------------

  private title(request: AllocationRequest): string {
    const t = this.t;
    switch (request.mode) {
      case 'start':
        return t('allocStartTitle', { task: request.taskTitle });
      case 'switch':
        return t('allocSwitchTitle');
      case 'context':
        return t('allocContextTitle', { org: request.org ?? t('moduleTime') });
      default:
        return t('allocStopTitle');
    }
  }

  private submitLabel(mode: AllocationMode): string {
    return this.t(mode === 'start' ? 'allocStart' : mode === 'switch' ? 'allocSwitch' : mode === 'context' ? 'allocContext' : 'allocStop');
  }

  private render(): void {
    const request = this.request;
    if (request === null) return;
    const t = this.t;
    const body = h('div', { class: 'dlg-b alloc-b' });
    if (request.mode === 'context') body.append(h('p', { class: 'alloc-lead' }, t('allocContextText', { org: request.org ?? '', target: request.target ?? '' })));
    body.append(
      h(
        'div',
        { class: 'alloc-summary' },
        chatIcon('clock', 'sm'),
        h('span', { class: 'as-task' }, request.taskTitle),
        request.startedAt !== null ? h('b', { class: 'as-time', id: 'alloc-elapsed' }, clock(request.startedAt, this.now())) : null,
      ),
    );
    if (request.missing.activityType) {
      body.append(h('div', { class: 'alloc-policy' }, chatIcon('shield', 'sm'), h('span', {}, request.org !== null ? t('allocPolicy', { org: request.org }) : t('allocPolicyGeneric'))));
    }
    body.append(h('div', { class: 'form-row', id: 'alloc-activity-row' }));
    if (this.subjectType !== null) body.append(this.subjectRow());
    const cancel = h('button', { class: 'btn', id: 'alloc-cancel', attrs: { type: 'button' } }, t('cancel'));
    cancel.addEventListener('click', () => this.dialog.close());
    const submit = h('button', { class: 'btn primary', id: 'alloc-submit', attrs: { type: 'submit' } }, chatIcon(request.mode === 'start' ? 'play' : 'stop', 'sm'), this.submitLabel(request.mode));
    const form = h('form', { attrs: { novalidate: true } }, h('div', { class: 'dlg-h' }, h('h1', { id: 'alloc-title' }, this.title(request))), body, h('div', { class: 'dlg-f' }, cancel, submit));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.dialog.replaceChildren(h('div', { class: 'dlg alloc' }, form));
    this.renderActivity();
  }

  private renderActivity(): void {
    const request = this.request;
    const row = this.dialog.querySelector<HTMLElement>('#alloc-activity-row');
    if (request === null || row === null) return;
    const t = this.t;
    const required = request.missing.activityType;
    const label = h('label', { attrs: { for: 'alloc-activity' } }, t('allocActivity'), required ? h('span', { class: 'req', attrs: { 'aria-hidden': 'true' } }, '*') : h('span', { class: 'opt' }, ` ${t('allocOptional')}`));
    const select = h('select', { class: 'selectish', id: 'alloc-activity', attrs: { 'aria-required': required ? 'true' : 'false', 'aria-invalid': 'false', 'aria-describedby': 'alloc-activity-help' } });
    const status = h('span', { class: 'help', id: 'alloc-activity-help' });
    const load = this.load;
    if (load.kind === 'loading') {
      select.append(h('option', { attrs: { value: '' } }, t('allocActivityLoading')));
      select.disabled = true;
      row.setAttribute('aria-busy', 'true');
    } else {
      row.removeAttribute('aria-busy');
      select.append(h('option', { attrs: { value: '' } }, t('allocActivityChoose')));
      const list = load.kind === 'ready' ? load.list : [];
      for (const group of groupActivities(list)) {
        const options = group.items.map((item) => h('option', { attrs: { value: item.key, selected: item.key === this.activity } }, item.label));
        if (group.group === null) select.append(...options);
        else select.append(h('optgroup', { attrs: { label: group.group } }, ...options));
      }
      select.disabled = load.kind !== 'ready' || list.length === 0;
    }
    select.addEventListener('change', () => {
      this.activity = select.value === '' ? null : select.value;
      if (this.activity !== null) this.markValid(row, select);
    });
    // One help line, always present (fixed height): the state of the list, or the inherited hint.
    if (load.kind === 'offline' || load.kind === 'limited') {
      status.classList.add('warn');
      status.append(load.kind === 'offline' ? t('allocActivityOffline') : t('allocRateLimited', { seconds: Math.max(1, Math.ceil((load.until - this.now()) / 1000)) }), ' ');
      const retry = h('button', { class: 'link-btn', id: 'alloc-activity-retry', attrs: { type: 'button' } }, chatIcon('refresh', 'xs'), t('allocRetry'));
      retry.addEventListener('click', () => void this.loadActivities());
      status.append(retry);
    } else if (load.kind === 'ready' && load.list.length === 0) {
      status.append(t('allocActivityEmpty'));
    } else if (request.inherited === true && this.activity !== null) {
      status.append(t('allocInherited'));
    } else {
      status.append(' ');
    }
    const error = h('span', { class: 'field-err', id: 'alloc-activity-err' }, t('allocActivityRequired'));
    row.classList.toggle('invalid', this.submitted && required && this.activity === null);
    // The state line and the error share one line (no layout shift when the error appears).
    row.replaceChildren(label, select, h('div', { class: 'row-msg' }, status, error));
    if (row.classList.contains('invalid')) this.markInvalid(row, select);
  }

  private subjectRow(): HTMLElement {
    const t = this.t;
    const request = this.request as AllocationRequest;
    const types = taskSubjectTypes(request.features);
    const row = h('div', { class: 'form-row', id: 'alloc-subject-row' });
    const label = h('label', { attrs: { for: 'alloc-subject' } }, t('allocSubject'), h('span', { class: 'opt' }, ` ${t('allocOptional')}`));
    const input = h('input', {
      id: 'alloc-subject',
      attrs: { type: 'text', role: 'combobox', autocomplete: 'off', spellcheck: 'false', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'alloc-subject-list', placeholder: t('allocSubjectPlaceholder'), maxlength: '100', 'aria-describedby': 'alloc-subject-help' },
    });
    input.value = this.subject?.label ?? '';
    const list = h('div', { class: 'combo-list', id: 'alloc-subject-list', attrs: { role: 'listbox', 'aria-label': t('allocSubject'), hidden: true } });
    const clear = h('button', { class: 'combo-clear', id: 'alloc-subject-clear', attrs: { type: 'button', 'aria-label': t('allocSubjectClear'), title: t('allocSubjectClear'), hidden: this.subject === null } }, chatIcon('x', 'xs'));
    clear.addEventListener('click', () => {
      this.subject = null;
      input.value = '';
      clear.hidden = true;
      input.focus();
    });
    const controls = h('div', { class: 'combo' });
    if (types.length > 1) {
      const type = h('select', { class: 'selectish combo-type', id: 'alloc-subject-type', attrs: { 'aria-label': t('allocSubjectType') } }, ...types.map((item) => h('option', { attrs: { value: item.type, selected: item.type === this.subjectType } }, item.label)));
      type.addEventListener('change', () => {
        this.subjectType = type.value;
        this.subject = null;
        input.value = '';
        clear.hidden = true;
        this.queueSearch('');
      });
      controls.append(type);
    }
    controls.append(h('div', { class: 'combo-field' }, input, clear, list));
    input.addEventListener('input', () => {
      if (this.subject !== null && input.value !== this.subject.label) {
        this.subject = null;
        clear.hidden = true;
      }
      this.queueSearch(input.value);
    });
    input.addEventListener('blur', () => setTimeout(() => this.closeList(), 120));
    input.addEventListener('keydown', (event) => this.onComboKey(event));
    row.append(label, controls, h('span', { class: 'help', id: 'alloc-subject-help' }, t('allocSubjectHint')));
    return row;
  }

  private queueSearch(query: string): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    const limited = this.search.kind === 'limited' && this.search.until > this.now();
    if (!limited) this.search = { kind: 'searching' };
    this.renderList();
    if (limited) return;
    this.searchTimer = setTimeout(() => void this.runSearch(query), SEARCH_DELAY_MS);
  }

  private async runSearch(query: string): Promise<void> {
    const request = this.request;
    const type = this.subjectType;
    if (request === null || type === null) return;
    const seq = ++this.searchSeq;
    try {
      const list = await request.searchSubjects(type, query);
      if (seq !== this.searchSeq || this.request !== request) return;
      this.search = { kind: 'results', list };
    } catch (error) {
      if (seq !== this.searchSeq || this.request !== request) return;
      this.search = error instanceof ApiError && error.status === 429 ? { kind: 'limited', until: this.now() + (error.retryAfter ?? 30) * 1000 } : { kind: 'offline' };
    }
    this.optionIndex = this.search.kind === 'results' && this.search.list.length > 0 ? 0 : -1;
    this.renderList();
    if (this.search.kind === 'results') this.announce(this.t('allocSubjectResults', { count: this.search.list.length }));
  }

  private renderList(): void {
    const list = this.dialog.querySelector<HTMLElement>('#alloc-subject-list');
    const input = this.dialog.querySelector<HTMLInputElement>('#alloc-subject');
    if (list === null || input === null) return;
    const t = this.t;
    const search = this.search;
    const note = (text: string, tone = '') => h('div', { class: `combo-note${tone}`, attrs: { role: 'presentation' } }, text);
    if (search.kind === 'idle') {
      this.closeList();
      return;
    }
    if (search.kind === 'searching') list.replaceChildren(note(t('allocSubjectSearching')));
    else if (search.kind === 'offline') list.replaceChildren(note(t('allocActivityOffline'), ' warn'));
    else if (search.kind === 'limited') list.replaceChildren(note(t('allocRateLimited', { seconds: Math.max(1, Math.ceil((search.until - this.now()) / 1000)) }), ' warn'));
    else if (search.list.length === 0) list.replaceChildren(note(t('allocSubjectNone')));
    else {
      list.replaceChildren(
        ...search.list.map((subject, index) => {
          const option = h('div', { class: 'combo-opt', id: `alloc-subject-${index}`, attrs: { role: 'option', 'aria-selected': index === this.optionIndex ? 'true' : 'false' } }, h('span', { class: 'co-t' }, subject.label), subject.hint ? h('span', { class: 'co-h' }, subject.hint) : null);
          // `mousedown`: before the input's blur closes the list.
          option.addEventListener('mousedown', (event) => {
            event.preventDefault();
            this.pick(subject);
          });
          return option;
        }),
      );
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (this.optionIndex >= 0) input.setAttribute('aria-activedescendant', `alloc-subject-${this.optionIndex}`);
    else input.removeAttribute('aria-activedescendant');
  }

  private closeList(): void {
    const list = this.dialog.querySelector<HTMLElement>('#alloc-subject-list');
    const input = this.dialog.querySelector<HTMLInputElement>('#alloc-subject');
    if (list !== null) list.hidden = true;
    input?.setAttribute('aria-expanded', 'false');
    input?.removeAttribute('aria-activedescendant');
  }

  private pick(subject: Subject): void {
    this.subject = subject;
    const input = this.dialog.querySelector<HTMLInputElement>('#alloc-subject');
    if (input !== null) input.value = subject.label;
    const clear = this.dialog.querySelector<HTMLElement>('#alloc-subject-clear');
    if (clear !== null) clear.hidden = false;
    this.search = { kind: 'idle' };
    this.closeList();
  }

  private onComboKey(event: KeyboardEvent): void {
    const results = this.search.kind === 'results' ? this.search.list : [];
    const open = this.dialog.querySelector<HTMLElement>('#alloc-subject-list')?.hidden === false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        this.queueSearch((event.target as HTMLInputElement).value);
        return;
      }
      if (results.length === 0) return;
      this.optionIndex = (this.optionIndex + (event.key === 'ArrowDown' ? 1 : results.length - 1) + results.length) % results.length;
      this.renderList();
      this.dialog.querySelector(`#alloc-subject-${this.optionIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter' && open && this.optionIndex >= 0 && results[this.optionIndex] !== undefined) {
      event.preventDefault();
      this.pick(results[this.optionIndex]);
    } else if (event.key === 'Escape' && open) {
      // The first Esc closes the list, the next one the dialog.
      event.preventDefault();
      event.stopPropagation();
      this.search = { kind: 'idle' };
      this.closeList();
    }
  }

  private markInvalid(row: HTMLElement, select: HTMLSelectElement): void {
    row.classList.add('invalid');
    select.setAttribute('aria-invalid', 'true');
    select.setAttribute('aria-describedby', 'alloc-activity-err');
  }

  private markValid(row: HTMLElement, select: HTMLSelectElement): void {
    row.classList.remove('invalid');
    select.setAttribute('aria-invalid', 'false');
    select.setAttribute('aria-describedby', 'alloc-activity-help');
  }

  private focusFirst(): void {
    const request = this.request;
    if (request === null) return;
    const target = request.missing.activityType ? this.dialog.querySelector<HTMLElement>('#alloc-activity') : this.dialog.querySelector<HTMLElement>('#alloc-submit');
    // The select is disabled while loading: the dialog itself then holds focus until it is ready.
    (target !== null && !(target as HTMLSelectElement).disabled ? target : this.dialog.querySelector<HTMLElement>('#alloc-cancel'))?.focus();
  }

  private submit(): void {
    const request = this.request;
    if (request === null) return;
    this.submitted = true;
    if (request.missing.activityType && this.activity === null) {
      const row = this.dialog.querySelector<HTMLElement>('#alloc-activity-row');
      const select = this.dialog.querySelector<HTMLSelectElement>('#alloc-activity');
      if (row !== null && select !== null) {
        this.markInvalid(row, select);
        if (!select.disabled) select.focus();
      }
      this.announce(this.t('allocMissing'));
      return;
    }
    const value = allocationOf(this.activity, this.subject);
    this.finish(value);
    this.dialog.close();
  }
}
