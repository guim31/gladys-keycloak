// -----------------------------------------------------------------------------
// Keycloak Admin REST API client, checked against Keycloak 26.4.7. A
// confidential client with a service account gets its token by the
// client_credentials grant, renewed before it expires (and once more on a
// 401):
//
//   POST /realms/{auth realm}/protocol/openid-connect/token
//   GET  /admin/realms/{realm}/events?type=LOGIN&type=LOGIN_ERROR…
//        &dateFrom={ms}&first=N&max=100      user events, latest first
//   GET  /admin/realms/{realm}/admin-events?resourceTypes=USER…
//        &dateFrom={ms}&first=N&max=100      admin events, latest first
//   GET  /admin/realms/{realm}/attack-detection/brute-force/users/{id}
//                                            { disabled, numFailures, … }
//   GET  /admin/realms/{realm}/users/{id}    the user name of a locked account
//   GET  /admin/realms/{realm}/users/count   human accounts (service accounts
//                                            left out)
//   GET  /admin/realms/{realm}/client-session-stats
//                                            [{ clientId, active, offline }]
//   GET  /admin/serverinfo                   systemInfo.version, only for a
//                                            client of the master realm
//
// `dateFrom` takes epoch milliseconds in recent versions (26.4 checked); an
// older Keycloak that answers 400 to it gets the day (yyyy-MM-dd, the day
// before, whatever its time zone) and the events are cut here. The roles of the service account, on the
// `realm-management` client of the realm (or `<realm>-realm` of master):
// view-events, view-users, view-realm.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall
  TLS: 'tls', // the certificate does not verify
  AUTH: 'auth', // client id or secret refused, no service account
  FORBIDDEN: 'forbidden', // a role missing for the service account (403)
  REALM: 'realm', // the realm does not exist
  NOT_KEYCLOAK: 'not_keycloak', // something answers, not Keycloak
  HTTP: 'http', // any other HTTP error
});

export class KeycloakError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'KeycloakError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
  // https:// on a plain HTTP port (Keycloak's 8080).
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'EPROTO',
]);

// /admin/serverinfo weighs about 300 KB; a page of 100 events far less.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

// The user events the integration follows: the others (code to token,
// refresh, logout…) are no security news and would only cost pages.
export const USER_EVENT_TYPES = Object.freeze([
  'LOGIN',
  'LOGIN_ERROR',
  'USER_DISABLED_BY_TEMPORARY_LOCKOUT',
  'USER_DISABLED_BY_PERMANENT_LOCKOUT',
]);

// The admin events read: users, role mappings, clients, the realm itself.
export const ADMIN_RESOURCE_TYPES = Object.freeze([
  'USER',
  'REALM_ROLE_MAPPING',
  'CLIENT_ROLE_MAPPING',
  'CLIENT',
  'REALM',
]);

// Roles that give administration rights: the client roles of
// `realm-management` (or `<realm>-realm` in master) that manage something,
// and the realm roles `admin` and `create-realm` of master.
export const ADMIN_ROLES = Object.freeze([
  'admin',
  'create-realm',
  'realm-admin',
  'create-client',
  'impersonation',
  'manage-authorization',
  'manage-clients',
  'manage-events',
  'manage-identity-providers',
  'manage-realm',
  'manage-users',
]);

export const PAGE_SIZE = 100;

// The token is renewed when it has less than this left (Keycloak gives
// 60 s in master, 300 s elsewhere by default).
export const TOKEN_MARGIN_MS = 20_000;

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0';
  }
})();
export const USER_AGENT = `gladys-keycloak/${VERSION}`;

/**
 * The one function that talks to the network (fetch). The client takes it as
 * a parameter: the tests replace it with an in-memory Keycloak
 * (test/helpers/fakeKeycloak.js).
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000 }) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error('Response too large');
    }
    chunks.push(chunk);
  }
  return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
}

const str = (value, max = 255) => (typeof value === 'string' ? value.slice(0, max) : '');
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const LOCKOUTS = {
  USER_DISABLED_BY_TEMPORARY_LOCKOUT: 'temporary',
  USER_DISABLED_BY_PERMANENT_LOCKOUT: 'permanent',
};

/**
 * A user event, kept small; null when unusable.
 * @returns {{ id: string, type: string, time: number, userId: string,
 *   username: string, ip: string, client: string, error: string,
 *   lockout: string }|null}
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.time)) {
    return null;
  }
  const details = object(raw.details);
  const type = str(raw.type, 64);
  // Keycloak 22+ gives every event an id; before, the fields make one.
  const id =
    str(raw.id, 64) ||
    [raw.time, type, raw.userId, raw.sessionId, raw.ipAddress, raw.clientId].join('|');
  return {
    id,
    type,
    time: raw.time,
    userId: str(raw.userId, 64),
    // A failed login names the typed user, even an unknown one.
    username: str(details.username, 150),
    ip: str(raw.ipAddress, 64),
    client: str(raw.clientId, 128),
    error: str(raw.error, 64),
    lockout: LOCKOUTS[type] ?? '',
  };
}

/**
 * The kind of an admin event, null when not followed: user_created,
 * user_deleted, admin_role_granted, role_granted, client_changed,
 * realm_changed.
 */
export function adminKind(operation, resource, roles) {
  if (resource === 'USER') {
    return { CREATE: 'user_created', DELETE: 'user_deleted' }[operation] ?? null;
  }
  if (resource === 'REALM_ROLE_MAPPING' || resource === 'CLIENT_ROLE_MAPPING') {
    if (operation !== 'CREATE') {
      return null;
    }
    return roles.some((role) => ADMIN_ROLES.includes(role)) ? 'admin_role_granted' : 'role_granted';
  }
  if (resource === 'CLIENT') {
    return ['CREATE', 'UPDATE', 'DELETE'].includes(operation) ? 'client_changed' : null;
  }
  if (resource === 'REALM') {
    return operation === 'UPDATE' ? 'realm_changed' : null;
  }
  return null;
}

function parseRepresentation(text) {
  if (typeof text !== 'string' || text.length > 200_000) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * An admin event, kept small; null when unusable or not followed. The
 * representation (if "Include representation" is on in the realm) gives the
 * names: user created, roles granted, client.
 * @returns {{ id: string, type: 'ADMIN', kind: string, time: number,
 *   operation: string, resource: string, target: string, ip: string }|null}
 */
export function normalizeAdminEvent(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.time)) {
    return null;
  }
  const operation = str(raw.operationType, 32);
  const resource = str(raw.resourceType, 64);
  const path = str(raw.resourcePath, 255);
  const representation = parseRepresentation(raw.representation);
  const roles = Array.isArray(representation)
    ? representation.map((role) => str(object(role).name, 100)).filter(Boolean)
    : [];
  const kind = adminKind(operation, resource, roles);
  if (!kind) {
    return null;
  }
  const rep = object(representation);
  const target = roles.length > 0 ? roles.join(', ') : str(rep.username) || str(rep.clientId);
  return {
    id: str(raw.id, 64) || [raw.time, operation, resource, path].join('|'),
    type: 'ADMIN',
    kind,
    time: raw.time,
    operation,
    resource,
    target: target.slice(0, 200),
    ip: str(object(raw.authDetails).ipAddress, 64),
  };
}

export class KeycloakClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL (src/config.js parseServerUrl)
   * @param {string} options.authRealm realm of the client
   * @param {string} options.clientId
   * @param {string} options.clientSecret
   * @param {Function} [options.request] HTTP seam, httpRequest by default
   * @param {() => number} [options.now]
   */
  constructor({ url, authRealm, clientId, clientSecret, request = httpRequest, now }) {
    this.url = url;
    this.authRealm = authRealm;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.request = request;
    this.now = now ?? (() => Date.now());
    this.token = null;
    this.tokenExpires = 0;
    this.tokenPromise = null;
    // Set when Keycloak refuses `dateFrom` in milliseconds.
    this.dayDates = false;
  }

  /** One request; network errors turned into KeycloakError. */
  async send(url, options, what) {
    try {
      return await this.request(url, options);
    } catch (err) {
      if (err?.message === 'Response too large') {
        throw new KeycloakError(ERROR_KINDS.HTTP, `Answer too large on ${what}`);
      }
      const code = err?.cause?.code ?? err?.code;
      if (TLS_CODES.has(code)) {
        throw new KeycloakError(ERROR_KINDS.TLS, `Certificate refused (${code})`);
      }
      throw new KeycloakError(
        ERROR_KINDS.UNREACHABLE,
        `No answer from Keycloak (${code ?? err?.name ?? 'error'})`,
      );
    }
  }

  /** A valid access token, fetched or renewed when needed. */
  async ensureToken() {
    if (this.token && this.tokenExpires - this.now() > TOKEN_MARGIN_MS) {
      return this.token;
    }
    // Concurrent calls share the request.
    this.tokenPromise ??= this.fetchToken().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  async fetchToken() {
    const path = `/realms/${encodeURIComponent(this.authRealm)}/protocol/openid-connect/token`;
    const { status, body } = await this.send(
      `${this.url}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }).toString(),
      },
      'the token endpoint',
    );
    let data = null;
    try {
      data = JSON.parse(body);
    } catch {
      // handled below
    }
    if (status === 404 && /realm does not exist/i.test(body)) {
      throw new KeycloakError(ERROR_KINDS.REALM, `Realm of the client not found (HTTP 404)`, {
        status,
        realm: this.authRealm,
      });
    }
    if (status === 400 || status === 401) {
      // invalid_client / unauthorized_client: wrong id or secret, or the
      // client has no service account.
      const error = str(object(data).error, 64) || `HTTP ${status}`;
      throw new KeycloakError(ERROR_KINDS.AUTH, `Client credentials refused (${error})`, {
        status,
      });
    }
    if (status === 404 || (status >= 300 && status < 400) || (status === 200 && !data)) {
      throw new KeycloakError(ERROR_KINDS.NOT_KEYCLOAK, `No Keycloak here (HTTP ${status})`, {
        status,
      });
    }
    if (status !== 200) {
      throw new KeycloakError(ERROR_KINDS.HTTP, `HTTP ${status} on the token endpoint`, {
        status,
      });
    }
    const token = str(object(data).access_token, 64 * 1024);
    if (!token) {
      throw new KeycloakError(ERROR_KINDS.NOT_KEYCLOAK, 'No access token in the answer');
    }
    const lifetime = Number.isFinite(data.expires_in) ? data.expires_in * 1000 : 60_000;
    this.token = token;
    this.tokenExpires = this.now() + lifetime;
    return token;
  }

  /**
   * GET a path of the admin API, parsed.
   * @throws {KeycloakError}
   */
  async get(path, { retried = false } = {}) {
    const token = await this.ensureToken();
    const what = path.split('?')[0];
    const { status, body } = await this.send(
      `${this.url}/admin${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      },
      what,
    );
    if (status === 401) {
      // Revoked or expired early (Keycloak restarted with new keys): once more.
      this.token = null;
      if (!retried) {
        return this.get(path, { retried: true });
      }
      throw new KeycloakError(ERROR_KINDS.AUTH, 'Access token refused (HTTP 401)', { status });
    }
    if (status === 403) {
      throw new KeycloakError(ERROR_KINDS.FORBIDDEN, `Role missing for ${what}`, { status });
    }
    if (status === 404 && /realm not found/i.test(body)) {
      throw new KeycloakError(ERROR_KINDS.REALM, `Realm not found (${what})`, { status });
    }
    if (status === 404 || (status >= 300 && status < 400)) {
      throw new KeycloakError(ERROR_KINDS.NOT_KEYCLOAK, `HTTP ${status} on ${what}`, { status });
    }
    if (status < 200 || status >= 300) {
      throw new KeycloakError(ERROR_KINDS.HTTP, `HTTP ${status} on ${what}`, { status });
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new KeycloakError(ERROR_KINDS.NOT_KEYCLOAK, `The answer is not JSON (${what})`, {
        status,
      });
    }
  }

  realmPath(realm) {
    return `/realms/${encodeURIComponent(realm)}`;
  }

  /**
   * Events latest first, page after page, down to `from` (ms), or `maxPages`
   * pages.
   * @returns {Promise<{ events: object[], complete: boolean }>} complete:
   *   false when `maxPages` cut the reading short
   */
  async listEvents(path, normalize, from, maxPages) {
    const events = [];
    for (let page = 0; page < maxPages; page += 1) {
      const date = this.dayDates
        ? new Date(from - 24 * 3600_000).toISOString().slice(0, 10)
        : Math.floor(from);
      const query = `${path}&dateFrom=${date}&first=${page * PAGE_SIZE}&max=${PAGE_SIZE}`;
      let results;
      try {
        results = await this.get(query);
      } catch (err) {
        if (err instanceof KeycloakError && err.status === 400 && !this.dayDates) {
          this.dayDates = true; // an older Keycloak: dates only
          page -= 1;
          continue;
        }
        throw err;
      }
      if (!Array.isArray(results)) {
        throw new KeycloakError(ERROR_KINDS.NOT_KEYCLOAK, 'Unexpected answer (no event list)');
      }
      for (const raw of results) {
        // Latest first: an older event ends the reading (the day filter
        // returns more than asked).
        if (Number.isFinite(raw?.time) && raw.time < from) {
          return { events, complete: true };
        }
        const event = normalize(raw);
        if (event) {
          events.push(event);
        }
      }
      if (results.length < PAGE_SIZE) {
        return { events, complete: true };
      }
    }
    return { events, complete: false };
  }

  /** The followed user events since `from`. */
  userEvents(realm, from, maxPages) {
    const types = USER_EVENT_TYPES.map((type) => `type=${type}`).join('&');
    return this.listEvents(
      `${this.realmPath(realm)}/events?${types}`,
      normalizeEvent,
      from,
      maxPages,
    );
  }

  /** The followed admin events since `from`. */
  adminEvents(realm, from, maxPages) {
    const types = ADMIN_RESOURCE_TYPES.map((type) => `resourceTypes=${type}`).join('&');
    return this.listEvents(
      `${this.realmPath(realm)}/admin-events?${types}`,
      normalizeAdminEvent,
      from,
      maxPages,
    );
  }

  /** Human accounts of the realm. */
  async userCount(realm) {
    const count = await this.get(`${this.realmPath(realm)}/users/count`);
    if (!Number.isInteger(count)) {
      throw new KeycloakError(ERROR_KINDS.NOT_KEYCLOAK, 'Unexpected answer (no user count)');
    }
    return count;
  }

  /** Active sessions, one per user and application (offline ones left out). */
  async sessionCount(realm) {
    const stats = await this.get(`${this.realmPath(realm)}/client-session-stats`);
    if (!Array.isArray(stats)) {
      throw new KeycloakError(ERROR_KINDS.NOT_KEYCLOAK, 'Unexpected answer (no session stats)');
    }
    return stats.reduce((sum, entry) => {
      const active = Number(object(entry).active);
      return sum + (Number.isInteger(active) && active > 0 ? active : 0);
    }, 0);
  }

  /** Whether the brute-force protection holds the account locked now. */
  async isLocked(realm, userId) {
    const data = object(
      await this.get(
        `${this.realmPath(realm)}/attack-detection/brute-force/users/${encodeURIComponent(userId)}`,
      ),
    );
    return data.disabled === true;
  }

  /** The user name of an account, '' when unknown (deleted). */
  async username(realm, userId) {
    try {
      const data = object(
        await this.get(`${this.realmPath(realm)}/users/${encodeURIComponent(userId)}`),
      );
      return str(data.username, 150);
    } catch (err) {
      if (err instanceof KeycloakError && err.status === 404) {
        return '';
      }
      throw err;
    }
  }

  /** The version of Keycloak, '' when hidden (a client outside master). */
  async version() {
    const data = object(await this.get('/serverinfo'));
    return str(object(data.systemInfo).version, 32);
  }
}
