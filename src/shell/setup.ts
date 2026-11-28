/**
 * Guided first run (UX batch 6, UXA-4; owner approval 2026-11-27): after the time approval, one card walks through the
 * other two device approvals, Chat then Tasks, each started in place from the card (design §4.2 "Connect chat too?").
 * Every step can be skipped, the whole setup can be finished later (Settings → Account → Finish setup), and a setup
 * left open when the app quits comes back at the next launch. When nothing is left, the app lands on Chat (owner Q1).
 *
 * The device flows are the modules' own (`connectChat`, `connectTasks`): this card only reads their state and draws
 * it, with ids of its own (`setup-*`), so the modules' connect cards stay as they are.
 */
import { type Child, h, patch } from '../ui/dom';
import { chatIcon } from '../chat/icons';
import type { ChatModule } from '../chat/module';
import type { TasksModule } from '../tasks/module';
import type { ShellText } from './i18n';

export type SetupStep = 'chat' | 'tasks';

/** `null`: never run; `pending`: on screen (back at the next launch); `done`: finished, skipped or left for later. */
export type SetupState = 'pending' | 'done' | null;

export interface SetupDeps {
  t: ShellText;
  chat: ChatModule;
  tasks: TasksModule | null;
  /** Tasks hidden by the server (`403 module_forbidden`): its step is passed over. */
  tasksHidden(): boolean;
  /** The server does not offer tasks (0.14.1, Beacon before 1.183): the step is not shown at all. */
  tasksUnavailable?(): boolean;
  /** Steps skipped (kept with the shell's preferences). */
  skipped(): readonly SetupStep[];
  /** Who is signed in and in which organization (UXA-23: the time step names them, not the server address). */
  signedIn?(): { name: string; org: string | null };
  skip(step: SetupStep): void;
  copy(text: string): void;
  openVerification(url: string): void;
  /** Nothing left: land on Chat. */
  finish(): void;
  /** "Finish later". */
  later(): void;
}

type StepState = 'done' | 'skipped' | 'todo';

export class SetupView {
  readonly root: HTMLElement;
  private readonly card: HTMLElement;

  constructor(private readonly deps: SetupDeps) {
    this.card = h('div', { class: 'setup-card' });
    this.root = h('section', { class: 'module setup', id: 'mod-setup', attrs: { hidden: true, 'aria-labelledby': 'setup-title' } }, this.card);
  }

  private stateOf(step: SetupStep): StepState {
    if (step === 'chat' ? this.deps.chat.connected : this.deps.tasks?.connected === true) return 'done';
    if (step === 'tasks' && (this.deps.tasks === null || this.deps.tasksHidden())) return 'skipped';
    return this.deps.skipped().includes(step) ? 'skipped' : 'todo';
  }

  /** The steps of this host (Tasks only where the host has it). */
  steps(): SetupStep[] {
    return this.deps.tasks === null || this.deps.tasksUnavailable?.() === true ? ['chat'] : ['chat', 'tasks'];
  }

  /** The step to do now, `null` when everything is connected or skipped. */
  active(): SetupStep | null {
    return this.steps().find((step) => this.stateOf(step) === 'todo') ?? null;
  }

  /** Something is still to connect (and not skipped). */
  needed(): boolean {
    return this.active() !== null;
  }

  private button(className: string, label: string, onClick: () => void, id: string, disabled = false): HTMLButtonElement {
    const button = h('button', { class: className, id, key: id, attrs: { type: 'button', disabled: disabled || undefined } }, label);
    button.addEventListener('click', onClick);
    return button;
  }

  private start(step: SetupStep): void {
    if (step === 'chat') void this.deps.chat.connectChat();
    else void this.deps.tasks?.connectTasks();
  }

  private cancel(step: SetupStep): void {
    if (step === 'chat') this.deps.chat.cancelConnect();
    else this.deps.tasks?.cancelConnect();
  }

  /** The active step's actions: Connect / Skip, or the device code while Beacon waits for the approval. */
  private actions(step: SetupStep): Child[] {
    const t = this.deps.t;
    const connect = step === 'chat' ? this.deps.chat.connect : (this.deps.tasks?.connect ?? { kind: 'idle' as const, message: null });
    if (connect.kind === 'code') {
      return [
        h('p', { class: 'cc-wait', attrs: { role: 'status' } }, t('setupWaiting')),
        h('div', { class: 'cc-code' }, h('span', { class: 'cc-code-label' }, t('setupCode')), h('output', { class: 'cc-code-value', id: 'setup-code' }, connect.userCode)),
        h(
          'div',
          { class: 'cc-row' },
          this.button('btn primary', t('setupOpen'), () => this.deps.openVerification(connect.url), 'setup-open'),
          this.button('btn', t('setupCopy'), () => this.deps.copy(connect.userCode.replace('-', '')), 'setup-copy'),
          this.button('btn-ghost', t('setupCancel'), () => this.cancel(step), 'setup-cancel'),
        ),
      ];
    }
    const message = connect.kind === 'idle' ? connect.message : null;
    return [
      message !== null && h('p', { class: 'cc-error', attrs: { role: 'alert' } }, message),
      h(
        'div',
        { class: 'cc-row' },
        this.button('btn primary', t(step === 'chat' ? 'setupConnectChat' : 'setupConnectTasks'), () => this.start(step), 'setup-connect', connect.kind === 'starting'),
        this.button('btn', t('setupSkip'), () => this.deps.skip(step), 'setup-skip'),
      ),
    ];
  }

  render(): void {
    if (this.root.hidden) return;
    const t = this.deps.t;
    const active = this.active();
    const steps = this.steps();
    const total = steps.length + 1;
    const row = (n: number, id: string, title: string, text: string, state: StepState | 'active', extra: Child[] = []) =>
      h(
        'li',
        { class: `setup-step ${state}`, id: `setup-step-${id}`, attrs: { 'aria-current': state === 'active' ? 'step' : undefined } },
        h('span', { class: 'st-mark', attrs: { 'aria-hidden': 'true' } }, state === 'done' ? chatIcon('check', 'sm') : String(n)),
        h(
          'div',
          { class: 'st-body' },
          h('h2', { class: 'st-title' }, title, h('span', { class: 'sr-only' }, ` · ${t('setupStepOf', { n, total })}`)),
          h('p', { class: 'st-text' }, state === 'done' && id !== 'time' ? t('setupDone') : state === 'skipped' ? t(id === 'tasks' && (this.deps.tasks === null || this.deps.tasksHidden()) ? 'setupTasksOff' : 'setupSkipped') : text),
          ...extra,
        ),
      );
    const who = this.deps.signedIn?.();
    const timeText = who !== undefined && who.name !== '' && who.org !== null ? t('setupTimeSigned', { name: who.name, org: who.org }) : t('setupTimeText');
    const items = [row(1, 'time', t('connTime'), timeText, 'done')];
    steps.forEach((step, index) => {
      const state = step === active ? 'active' : this.stateOf(step);
      items.push(row(index + 2, step, t(step === 'chat' ? 'connChat' : 'connTasks'), t(step === 'chat' ? 'setupChatText' : 'setupTasksText'), state, state === 'active' ? this.actions(step) : []));
    });
    patch(
      this.card,
      [
        h('span', { class: 'cc-ico', attrs: { 'aria-hidden': 'true' } }, chatIcon('beacon', 'lg')),
        h('h1', { id: 'setup-title' }, t('setupTitle')),
        h('p', { class: 'cc-text' }, t('setupLead')),
        h('ol', { class: 'setup-steps', attrs: { 'aria-label': t('setupSteps') } }, ...items),
        h('div', { class: 'setup-foot' }, this.button('btn-ghost', t('setupLater'), () => this.deps.later(), 'setup-later')),
      ],
      '#setup-connect',
    );
  }

  /** Puts focus on the active step's first action (or the card's title when nothing is left). */
  focus(): void {
    (this.root.querySelector<HTMLElement>('#setup-connect:not([disabled]), #setup-open') ?? this.root.querySelector<HTMLElement>('#setup-later'))?.focus();
  }
}
