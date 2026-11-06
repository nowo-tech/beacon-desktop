import { ApiError } from '../api/client';
import type { MessageKey } from './i18n';
import { hostOf } from './serverUrl';

/** What the user can do about an error. `retry` repeats the failed action; `copy` copies the technical details. */
export type ErrorAction = 'retry' | 'copy' | 'reconnect' | 'help';

/** A failure as the user sees it: a short title, the next step, actions. The raw server message only goes to details. */
export interface ErrorView {
  id: string;
  title: MessageKey;
  text: MessageKey;
  params: Record<string, string | number>;
  actions: ErrorAction[];
  details: string;
}

/** Where the failure happened: the connect flow has its own, more precise messages. */
export type ErrorStage = 'preflight' | 'deviceCode' | 'action';

export interface ErrorContext {
  stage: ErrorStage;
  server: string | null;
  version: string;
  /** Title of the task the action was about, if any. */
  task?: string;
  now?: Date;
}

/** Technical details for "Copy details": code, HTTP status, server, app version, raw message. Never shown as text. */
export function errorDetails(error: unknown, context: ErrorContext): string {
  const api = error instanceof ApiError ? error : null;
  return [
    `TimeTrack desktop ${context.version}`,
    `server: ${context.server ?? '-'}`,
    `stage: ${context.stage}`,
    `code: ${api?.code ?? 'client_error'}`,
    `status: ${api?.status ?? '-'}`,
    `message: ${error instanceof Error ? error.message : String(error)}`,
    `at: ${(context.now ?? new Date()).toISOString()}`,
  ].join('\n');
}

/** Start at login refused by the host (src-tauri/src/autostart.rs, `autostart:<code>: …`), with its own message. */
const AUTOSTART_TEXT: Record<string, MessageKey> = {
  elevated: 'errAutostartElevated',
  not_installed: 'errAutostartNotInstalled',
  taken: 'errAutostartTaken',
};

function autostartRefusal(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const code = /^autostart:([a-z_]+):/.exec(message)?.[1];
  return code !== undefined && code in AUTOSTART_TEXT ? code : null;
}

/** Maps any failure to the error catalogue (UX request R2 / proposal §3 G). */
export function describeError(error: unknown, context: ErrorContext): ErrorView {
  const host = hostOf(context.server);
  const view = (id: string, title: MessageKey, text: MessageKey, actions: ErrorAction[], params: Record<string, string | number> = {}): ErrorView => ({
    id,
    title,
    text,
    params: { host, task: context.task ?? '', ...params },
    actions,
    details: errorDetails(error, context),
  });
  const autostart = autostartRefusal(error);
  if (autostart !== null) return view(`autostart_${autostart}`, 'errAutostartTitle', AUTOSTART_TEXT[autostart], ['copy']);
  if (!(error instanceof ApiError)) return view('generic', 'errGenericTitle', 'errGenericText', ['retry', 'copy']);
  if (error.isNetwork) return view('unreachable', 'errUnreachableTitle', 'errUnreachableText', ['retry', 'copy']);
  if (context.stage === 'preflight' && (error.status === 404 || error.status === 405)) {
    return view('not_beacon', 'errNotBeaconTitle', 'errNotBeaconText', ['retry', 'help', 'copy']);
  }
  if (context.stage === 'deviceCode' && (error.status === 404 || error.status === 405)) {
    return view('no_device_flow', 'errNoDeviceFlowTitle', 'errNoDeviceFlowText', ['retry', 'copy']);
  }
  if (error.status === 429) {
    return view('rate_limited', 'errRateLimitedTitle', error.retryAfter !== null ? 'errRateLimitedWait' : 'errRateLimitedText', ['retry'], {
      seconds: Math.ceil(error.retryAfter ?? 0),
    });
  }
  switch (error.code) {
    case 'task_forbidden':
      return view('task_forbidden', 'errTaskForbiddenTitle', 'errTaskForbiddenText', ['copy']);
    case 'insufficient_scope':
      return view('insufficient_scope', 'errScopeTitle', 'errScopeText', ['reconnect']);
    case 'timer_running':
      return view('timer_running', 'errTimerRunningTitle', 'errTimerRunningText', ['retry']);
    case 'invalid_response':
      return view('invalid_response', 'errNotBeaconTitle', 'errNotBeaconText', ['retry', 'help', 'copy']);
  }
  if (error.status >= 500) return view('server', 'errServerTitle', 'errServerText', ['retry', 'copy']);
  return view('generic', 'errGenericTitle', 'errGenericText', ['retry', 'copy']);
}
