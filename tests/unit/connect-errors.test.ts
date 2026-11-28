import { describe, expect, it } from 'vitest';
import { ApiError, parseRetryAfter } from '../../src/api/client';
import { connectErrorMessage } from '../../src/chat/module';
import { chatText } from '../../src/chat/i18n';

/** 0.12.1: why the chat's chained `POST device/code` failed, in words. */
describe('connectErrorMessage', () => {
  const en = chatText('en');
  const es = chatText('es');

  it('401: the time session expired', () => {
    expect(connectErrorMessage(new ApiError(401, 'invalid_token', 'x'), en)).toBe('Your time tracking session expired. Connect it again, then connect chat.');
    expect(connectErrorMessage(new ApiError(401, 'invalid_token', 'x'), es)).toBe('Tu sesión del control de tiempo caducó. Conéctala de nuevo y después conecta el chat.');
  });

  it('429: the wait from Retry-After, seconds or HTTP date, capped; without it, "a moment"', () => {
    expect(connectErrorMessage(new ApiError(429, 'rate_limited', 'x', 7.2), en)).toBe('Too many attempts. Wait 8 s and try again.');
    expect(connectErrorMessage(new ApiError(429, 'rate_limited', 'x', 0), en)).toBe('Too many attempts. Wait 1 s and try again.');
    const now = Date.parse('2026-11-27T10:00:00Z');
    const date = parseRetryAfter('Fri, 27 Nov 2026 10:01:30 GMT', now);
    expect(connectErrorMessage(new ApiError(429, 'rate_limited', 'x', date), es)).toBe('Demasiados intentos. Espera 90 s y vuelve a intentarlo.');
    expect(connectErrorMessage(new ApiError(429, 'rate_limited', 'x', parseRetryAfter('999999')), en)).toBe('Too many attempts. Wait 1800 s and try again.');
    expect(connectErrorMessage(new ApiError(429, 'rate_limited', 'x'), en)).toBe('Too many attempts. Wait a moment and try again.');
  });

  it('a refusal of the chat family; the generic text only for network errors and 5xx', () => {
    for (const status of [400, 403, 404]) expect(connectErrorMessage(new ApiError(status, 'forbidden', 'x'), en)).toContain('Beacon did not accept');
    expect(connectErrorMessage(new ApiError(0, 'network_error', 'x'), en)).toBe('Could not start the connection. Check your network and try again.');
    expect(connectErrorMessage(new ApiError(503, 'server_error', 'x'), en)).toBe('Could not start the connection. Check your network and try again.');
    expect(connectErrorMessage(new Error('boom'), en)).toBe('Could not start the connection. Check your network and try again.');
  });
});
