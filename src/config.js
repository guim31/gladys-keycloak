// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One Keycloak server: its address, the realms to watch, a confidential client
// with a service account (id, secret, and the realm it lives in), the rule of
// the "series of failed logins" trigger.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['30', '60', '120', '300'];

// Windows of the "series of failed logins" trigger, in minutes.
export const BURST_WINDOWS = ['5', '10', '15', '30', '60'];

export const BURST_MIN = 2;
export const BURST_MAX = 100;

// Realms watched at most: each costs a few requests per read.
export const MAX_REALMS = 10;

export const DEFAULT_CONFIG = {
  url: '',
  realms: '',
  client_realm: '',
  client_id: '',
  client_secret: '',
  burst_count: 5,
  burst_window: '10',
  poll_interval: '60',
  language: 'fr',
};

/**
 * Parse the address typed by the user into a base URL: a bare host or IP
 * (`sso.example.com`, HTTPS by default; HTTP on port 8080) or a full URL. A
 * path copied from the browser (`/admin/…`, `/realms/…`) is dropped, any
 * other path kept (Keycloak under `/auth`, the old default, or a sub-path).
 * @param {unknown} raw
 * @returns {string|null} `http(s)://host[:port][/path]`, null when unusable
 */
export function parseServerUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  // Port 8080 is Keycloak's plain HTTP port, 8443 its HTTPS one.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : `${/:8080(\/|$)/.test(text) ? 'http' : 'https'}://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs.
  if (url.username || url.password) {
    return null;
  }
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(admin|realms)(\/.*)?$/i, '')
    .replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Host part shown to the user (no scheme). */
export const hostOf = (url) => url.replace(/^https?:\/\//, '');

/**
 * "home, family ;master" → ['home', 'family', 'master']: realm names, in the
 * order typed, without repeats. A realm name has no space, comma or slash.
 */
export function parseRealms(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  const names = raw
    .split(/[\s,;]+/)
    .filter((name) => name && name.length <= 100 && !/[/\\?#%]/.test(name));
  return [...new Set(names)].slice(0, MAX_REALMS);
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const typed = text('url');
  const choice = (key, list) =>
    list.includes(String(source[key])) ? String(source[key]) : DEFAULT_CONFIG[key];
  const count = Number(source.burst_count);
  const realms = parseRealms(source.realms);
  return {
    // '' when nothing was typed yet, null when what was typed is unusable.
    url: typed ? parseServerUrl(typed) : '',
    realms,
    // The realm of the client: the first realm watched when left empty.
    clientRealm: text('client_realm') || realms[0] || '',
    clientId: text('client_id'),
    clientSecret: text('client_secret'),
    burstCount:
      Number.isInteger(count) && count >= BURST_MIN && count <= BURST_MAX
        ? count
        : DEFAULT_CONFIG.burst_count,
    burstWindowMs: Number(choice('burst_window', BURST_WINDOWS)) * 60_000,
    pollIntervalMs: Number(choice('poll_interval', POLL_INTERVALS)) * 1000,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
