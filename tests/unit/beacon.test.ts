import { describe, expect, it } from 'vitest';
import { dashboardUrl, myTimeUrl, sameOriginHttps, taskUrl } from '../../src/lib/beacon';

const SERVER = 'https://beacon.example.com';

describe('Beacon links: same-origin https check', () => {
  it('accepts https URLs on the connected server origin', () => {
    expect(sameOriginHttps('https://beacon.example.com/dashboard/tasks/42', SERVER)).toBe('https://beacon.example.com/dashboard/tasks/42');
    expect(sameOriginHttps('https://BEACON.example.com:443/x?y=1#z', SERVER)).toBe('https://beacon.example.com/x?y=1#z');
    expect(sameOriginHttps('https://beacon.example.com/a', 'https://beacon.example.com/sub/path')).toBe('https://beacon.example.com/a');
    expect(taskUrl('https://beacon.example.com/dashboard/tasks/T-1', SERVER)).toBe('https://beacon.example.com/dashboard/tasks/T-1');
  });

  it('rejects other hosts, including look-alikes and subdomains', () => {
    expect(sameOriginHttps('https://evil.example.com/dashboard', SERVER)).toBeNull();
    expect(sameOriginHttps('https://beacon.example.com.evil.test/dashboard', SERVER)).toBeNull();
    expect(sameOriginHttps('https://sub.beacon.example.com/dashboard', SERVER)).toBeNull();
    expect(sameOriginHttps('//evil.example.com/dashboard', SERVER)).toBeNull();
  });

  it('rejects http:, javascript:, data: and other schemes', () => {
    expect(sameOriginHttps('http://beacon.example.com/dashboard', SERVER)).toBeNull();
    expect(sameOriginHttps('javascript:alert(1)', SERVER)).toBeNull();
    expect(sameOriginHttps('JavaScript:alert(document.domain)//https://beacon.example.com', SERVER)).toBeNull();
    expect(sameOriginHttps('data:text/html,<script>alert(1)</script>', SERVER)).toBeNull();
    expect(sameOriginHttps('file:///etc/passwd', SERVER)).toBeNull();
    expect(sameOriginHttps('ftp://beacon.example.com/x', SERVER)).toBeNull();
  });

  it('rejects userinfo', () => {
    expect(sameOriginHttps('https://user@beacon.example.com/dashboard', SERVER)).toBeNull();
    expect(sameOriginHttps('https://user:pass@beacon.example.com/dashboard', SERVER)).toBeNull();
    expect(sameOriginHttps('https://beacon.example.com@evil.example.com/dashboard', SERVER)).toBeNull();
  });

  it('rejects a different port, accepts the explicit default port', () => {
    expect(sameOriginHttps('https://beacon.example.com:8443/dashboard', SERVER)).toBeNull();
    expect(sameOriginHttps('https://beacon.example.com/dashboard', 'https://beacon.example.com:8443')).toBeNull();
    expect(sameOriginHttps('https://beacon.example.com:8443/dashboard', 'https://beacon.example.com:8443/')).toBe('https://beacon.example.com:8443/dashboard');
    expect(sameOriginHttps('https://beacon.example.com:443/dashboard', SERVER)).toBe('https://beacon.example.com/dashboard');
  });

  it('rejects everything when no server is connected or the server is not https', () => {
    for (const server of [null, undefined, '', 'not a url']) {
      expect(sameOriginHttps('https://beacon.example.com/dashboard', server)).toBeNull();
      expect(dashboardUrl(server)).toBeNull();
      expect(myTimeUrl(server)).toBeNull();
    }
    expect(sameOriginHttps('http://127.0.0.1:8787/dashboard', 'http://127.0.0.1:8787')).toBeNull();
    expect(dashboardUrl('http://127.0.0.1:8787')).toBeNull();
  });

  it('rejects missing, relative, malformed and non-string URLs', () => {
    for (const value of [null, undefined, '', '/dashboard/tasks/1', 'dashboard', 'https://', 42, {}, ['https://beacon.example.com/x']]) {
      expect(sameOriginHttps(value, SERVER)).toBeNull();
    }
  });

  it('builds the dashboard and "My time" links from the server URL', () => {
    expect(dashboardUrl(SERVER)).toBe('https://beacon.example.com/dashboard');
    expect(myTimeUrl(SERVER)).toBe('https://beacon.example.com/dashboard/tasks/time');
    expect(dashboardUrl('https://beacon.example.com/')).toBe('https://beacon.example.com/dashboard');
    expect(myTimeUrl('https://example.com/beacon')).toBe('https://example.com/beacon/dashboard/tasks/time');
  });
});
