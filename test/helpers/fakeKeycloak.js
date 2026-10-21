// -----------------------------------------------------------------------------
// An in-memory Keycloak (token endpoint and admin API), built on the answers
// of a real Keycloak 26.4.7 (test/fixtures/keycloak, recorded on 21/10/2026 in
// a `start-dev` container): its `request` replaces the network seam of the
// client. Events can be added, accounts locked, endpoints refused, tokens
// revoked.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/keycloak/${name}`, import.meta.url), 'utf8'));

export const FIXTURES = {
  events: read('events.json'),
  adminEvents: read('admin-events.json'),
  sessionStats: read('client-session-stats.json'),
  bruteForceLocked: read('brute-force-locked.json'),
  bruteForceFree: read('brute-force-free.json'),
  tokenError: read('token-error.json'),
};

export const BASE = 'https://sso.example.com';
export const CLIENT_ID = 'gladys';
export const CLIENT_SECRET = 'test-secret-not-a-secret';
// The accounts of the fixtures: bob got locked by the brute-force protection.
export const ALICE = '803097b8-2904-467c-90e6-50ad7fbcda86';
export const BOB = '1411df0b-5aa8-40c5-87a6-fa85321fc7f2';

const json = (status, data) => ({ status, body: JSON.stringify(data) });

export class FakeKeycloak {
  constructor({ events = FIXTURES.events, adminEvents = FIXTURES.adminEvents } = {}) {
    this.realms = new Set(['home', 'family', 'master']);
    /** @type {Array<object & { realm: string }>} */
    this.events = events.map((event) => ({ ...structuredClone(event), realm: 'home' }));
    this.adminEvents = adminEvents.map((event) => ({ ...structuredClone(event), realm: 'home' }));
    this.users = new Map([
      [ALICE, 'alice'],
      [BOB, 'bob'],
    ]);
    this.locked = new Set(events.length > 0 ? [BOB] : []);
    this.userCount = 2;
    this.sessionStats = structuredClone(FIXTURES.sessionStats);
    this.showVersion = true;
    this.clientRealm = 'home';
    this.tokenLifetime = 300;
    this.tokens = new Set();
    this.issued = 0;
    this.down = false;
    /** @type {Set<string>} path parts answered 403 (a role missing) */
    this.forbidden = new Set();
    this.requests = [];
    this.request = this.request.bind(this);
  }

  /** A new user event, like the ones Keycloak writes; returns it. */
  add(type, { realm = 'home', username = 'alice', userId, ip = '198.51.100.20', at, error } = {}) {
    const id = userId ?? [...this.users].find(([, name]) => name === username)?.[0];
    const event = {
      id: randomUUID(),
      time: at,
      type,
      realmId: `${realm}-id`,
      clientId: type.startsWith('LOGIN') ? 'test-app' : undefined,
      ...(id ? { userId: id } : {}),
      ipAddress: ip,
      ...(type === 'LOGIN_ERROR' ? { error: error ?? 'invalid_user_credentials' } : {}),
      details: type.startsWith('LOGIN')
        ? { auth_method: 'openid-connect', grant_type: 'password', username }
        : { reason: 'brute_force_attack detected', num_failures: '3' },
      realm,
    };
    this.events.push(event);
    return event;
  }

  /** A new admin event; returns it. */
  addAdmin(operationType, resourceType, { realm = 'home', at, representation, path = 'x' } = {}) {
    const event = {
      id: randomUUID(),
      time: at,
      realmId: `${realm}-id`,
      authDetails: {
        realmId: 'master-id',
        clientId: 'cli',
        userId: 'admin-id',
        ipAddress: '198.51.100.5',
      },
      operationType,
      resourceType,
      resourcePath: path,
      ...(representation ? { representation: JSON.stringify(representation) } : {}),
      realm,
    };
    this.adminEvents.push(event);
    return event;
  }

  /** Every token issued so far is refused (Keycloak restarted with new keys). */
  revokeTokens() {
    this.tokens.clear();
  }

  async request(url, { method = 'GET', headers = {}, body } = {}) {
    this.requests.push(`${method} ${url}`);
    if (this.down) {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    const parsed = new URL(url);
    if (parsed.origin !== BASE) {
      return { status: 404, body: 'Not Found' };
    }
    const token = parsed.pathname.match(/^\/realms\/([^/]+)\/protocol\/openid-connect\/token$/);
    if (token) {
      return this.token(decodeURIComponent(token[1]), method, new URLSearchParams(body));
    }
    const admin = parsed.pathname.match(/^\/admin(\/.*)$/);
    if (!admin) {
      return { status: 404, body: '<html>Not Found</html>' };
    }
    if (!this.tokens.has(String(headers.Authorization).replace(/^Bearer /, ''))) {
      return { status: 401, body: '{"error":"HTTP 401 Unauthorized"}' };
    }
    for (const part of this.forbidden) {
      if (parsed.pathname.includes(part)) {
        return json(403, { error: 'HTTP 403 Forbidden' });
      }
    }
    return this.admin(admin[1], parsed.searchParams);
  }

  token(realm, method, params) {
    if (!this.realms.has(realm)) {
      return json(404, { error: 'Realm does not exist' });
    }
    if (
      method !== 'POST' ||
      params.get('grant_type') !== 'client_credentials' ||
      realm !== this.clientRealm ||
      params.get('client_id') !== CLIENT_ID ||
      params.get('client_secret') !== CLIENT_SECRET
    ) {
      return json(401, FIXTURES.tokenError);
    }
    this.issued += 1;
    const accessToken = `token-${this.issued}`;
    this.tokens.add(accessToken);
    return json(200, {
      access_token: accessToken,
      expires_in: this.tokenLifetime,
      refresh_expires_in: 0,
      token_type: 'Bearer',
      'not-before-policy': 0,
      scope: 'profile email',
    });
  }

  admin(path, query) {
    if (path === '/serverinfo') {
      return json(200, this.showVersion ? { systemInfo: { version: '26.4.7' } } : { themes: {} });
    }
    const match = path.match(/^\/realms\/([^/]+)(\/.*)$/);
    if (!match) {
      return json(404, { error: 'HTTP 404 Not Found' });
    }
    const realm = decodeURIComponent(match[1]);
    const rest = match[2];
    if (!this.realms.has(realm)) {
      return json(404, { error: 'Realm not found.' });
    }
    const from = Number(query.get('dateFrom') ?? 0);
    const page = (list) => {
      const first = Number(query.get('first') ?? 0);
      const max = Number(query.get('max') ?? 100);
      return list
        .filter((event) => event.realm === realm && event.time >= from)
        .sort((a, b) => b.time - a.time)
        .slice(first, first + max)
        .map(({ realm: _realm, ...event }) => event);
    };
    if (rest === '/events') {
      const types = query.getAll('type');
      return json(200, page(this.events.filter((e) => !types.length || types.includes(e.type))));
    }
    if (rest === '/admin-events') {
      const types = query.getAll('resourceTypes');
      return json(
        200,
        page(this.adminEvents.filter((e) => !types.length || types.includes(e.resourceType))),
      );
    }
    if (rest === '/users/count') {
      return json(200, realm === 'home' ? this.userCount : 0);
    }
    if (rest === '/client-session-stats') {
      return json(200, realm === 'home' ? this.sessionStats : []);
    }
    const brute = rest.match(/^\/attack-detection\/brute-force\/users\/([^/]+)$/);
    if (brute) {
      return json(
        200,
        this.locked.has(decodeURIComponent(brute[1]))
          ? FIXTURES.bruteForceLocked
          : FIXTURES.bruteForceFree,
      );
    }
    const user = rest.match(/^\/users\/([^/]+)$/);
    if (user) {
      const name = this.users.get(decodeURIComponent(user[1]));
      return name
        ? json(200, { id: user[1], username: name, enabled: true })
        : json(404, { error: 'User not found' });
    }
    return json(404, { error: 'HTTP 404 Not Found' });
  }
}
