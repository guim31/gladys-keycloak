// -----------------------------------------------------------------------------
// The Keycloak client on the real answers of Keycloak 26.4.7
// (test/fixtures/keycloak): token, events, admin events, errors. No network:
// the fake Keycloak answers in memory.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_KINDS,
  KeycloakClient,
  adminKind,
  normalizeAdminEvent,
  normalizeEvent,
} from '../src/keycloak/client.js';
import { BASE, BOB, CLIENT_ID, CLIENT_SECRET, FIXTURES, FakeKeycloak } from './helpers/world.js';
import { parseRealms, parseServerUrl } from '../src/config.js';

const clientOf = (keycloak, extra = {}) =>
  new KeycloakClient({
    url: BASE,
    authRealm: 'home',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    request: keycloak.request,
    ...extra,
  });

test('the addresses typed are understood', () => {
  assert.equal(parseServerUrl('sso.example.com'), 'https://sso.example.com');
  assert.equal(parseServerUrl('192.0.2.4:8080'), 'http://192.0.2.4:8080');
  assert.equal(
    parseServerUrl('https://sso.example.com/admin/master/console/#/home'),
    'https://sso.example.com',
  );
  assert.equal(parseServerUrl('https://example.com/auth/realms/home/'), 'https://example.com/auth');
  assert.equal(parseServerUrl('https://user:pw@sso.example.com'), null);
  assert.equal(parseServerUrl('ftp://sso.example.com'), null);
  assert.deepEqual(parseRealms(' home, family;home  master'), ['home', 'family', 'master']);
  assert.deepEqual(parseRealms('a/b, ok'), ['ok']);
});

test('the real user events are read: logins, failures, the lockout', () => {
  const events = FIXTURES.events.map(normalizeEvent);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'LOGIN_ERROR',
      'LOGIN_ERROR',
      'LOGIN_ERROR',
      'USER_DISABLED_BY_TEMPORARY_LOCKOUT',
      'LOGIN_ERROR',
      'LOGIN_ERROR',
      'LOGIN',
    ],
  );
  // An unknown user: the typed name, no account id.
  assert.deepEqual(
    { ...events[0], id: undefined, time: undefined },
    {
      id: undefined,
      type: 'LOGIN_ERROR',
      time: undefined,
      userId: '',
      username: 'ghost',
      ip: '192.0.2.10',
      client: 'test-app',
      error: 'user_not_found',
      lockout: '',
    },
  );
  assert.equal(events[3].userId, BOB);
  assert.equal(events[3].lockout, 'temporary');
  assert.equal(events[3].username, '', 'a lockout names no user');
  assert.equal(events[6].username, 'alice');
});

test('the real admin events are classified; a role mapping names its roles', () => {
  const kinds = FIXTURES.adminEvents.map(normalizeAdminEvent).map((e) => e && [e.kind, e.target]);
  assert.deepEqual(kinds, [
    ['client_changed', 'test-app'],
    ['user_deleted', ''],
    ['role_granted', 'offline_access'],
    ['admin_role_granted', 'realm-admin'],
    ['user_created', 'carol'],
    ['role_granted', 'view-users, view-events, view-realm'],
    ['user_created', 'bob'],
    ['user_created', 'alice'],
    ['client_changed', 'gladys'],
    ['client_changed', 'test-app'],
  ]);
  assert.equal(adminKind('UPDATE', 'USER', []), null, 'a user update is no news');
  assert.equal(adminKind('DELETE', 'CLIENT_ROLE_MAPPING', ['admin']), null);
  assert.equal(adminKind('UPDATE', 'REALM', []), 'realm_changed');
  // Without "Include representation": no name, no way to tell an admin role.
  const bare = { ...FIXTURES.adminEvents[3], representation: undefined };
  assert.deepEqual(
    [normalizeAdminEvent(bare).kind, normalizeAdminEvent(bare).target],
    ['role_granted', ''],
  );
});

test('the token is fetched once, renewed before it expires, and again on a 401', async () => {
  const keycloak = new FakeKeycloak();
  let now = 0;
  const client = clientOf(keycloak, { now: () => now });
  await client.userCount('home');
  await client.userCount('home');
  assert.equal(keycloak.issued, 1);
  now += 290_000; // 10 s left of 300 s: renewed
  await client.userCount('home');
  assert.equal(keycloak.issued, 2);
  keycloak.revokeTokens();
  assert.equal(await client.userCount('home'), 2);
  assert.equal(keycloak.issued, 3);
  assert.ok(
    keycloak.requests.every((line) => !line.includes(CLIENT_SECRET)),
    'the secret is never in a URL',
  );
});

test('events are read with the filters, page after page', async () => {
  const keycloak = new FakeKeycloak({ events: [] });
  for (let i = 0; i < 250; i += 1) {
    keycloak.add('LOGIN', { at: 1_000 + i });
  }
  keycloak.add('CODE_TO_TOKEN', { at: 5_000 });
  const client = clientOf(keycloak);
  const all = await client.userEvents('home', 0, 10);
  assert.equal(all.events.length, 250);
  assert.equal(all.complete, true);
  const cut = await client.userEvents('home', 0, 2);
  assert.equal(cut.events.length, 200);
  assert.equal(cut.complete, false);
  const recent = await client.userEvents('home', 1_200, 10);
  assert.equal(recent.events.length, 50);
  assert.ok(keycloak.requests.some((line) => line.includes('dateFrom=1200')));
});

test('an older Keycloak refusing dates in milliseconds gets the day', async () => {
  const keycloak = new FakeKeycloak({ events: [] });
  keycloak.add('LOGIN', { at: Date.UTC(2026, 9, 20, 23, 0) });
  keycloak.add('LOGIN', { at: Date.UTC(2026, 9, 21, 10, 0) });
  const request = keycloak.request;
  keycloak.request = async (url, options) => {
    const date = new URL(url).searchParams.get('dateFrom');
    if (date && !/^\d{4}-\d\d-\d\d$/.test(date)) {
      return { status: 400, body: '{"error":"Invalid value for From date"}' };
    }
    if (date) {
      // Keycloak reads the day in its own time zone: a little more than asked.
      const day = Date.parse(`${date}T00:00:00Z`);
      return request(url.replace(`dateFrom=${date}`, `dateFrom=${day}`), options);
    }
    return request(url, options);
  };
  const client = clientOf(keycloak);
  const { events } = await client.userEvents('home', Date.UTC(2026, 9, 21, 9, 0), 10);
  assert.equal(events.length, 1);
  assert.equal(client.dayDates, true);
  assert.ok(keycloak.requests.at(-1).includes('dateFrom='));
});

test('the errors are told apart', async () => {
  const kindOf = async (fn) => {
    try {
      await fn();
    } catch (err) {
      return err.kind;
    }
    return 'none';
  };
  const keycloak = new FakeKeycloak();
  assert.equal(
    await kindOf(() => clientOf(keycloak, { clientSecret: 'wrong' }).userCount('home')),
    ERROR_KINDS.AUTH,
  );
  assert.equal(
    await kindOf(() => clientOf(keycloak, { authRealm: 'nope' }).userCount('home')),
    ERROR_KINDS.REALM,
  );
  assert.equal(await kindOf(() => clientOf(keycloak).userCount('nope')), ERROR_KINDS.REALM);
  keycloak.forbidden.add('/users/count');
  assert.equal(await kindOf(() => clientOf(keycloak).userCount('home')), ERROR_KINDS.FORBIDDEN);
  assert.equal(
    await kindOf(() =>
      new KeycloakClient({
        url: 'https://other.example.com',
        authRealm: 'home',
        clientId: 'a',
        clientSecret: 'b',
        request: keycloak.request,
      }).userCount('home'),
    ),
    ERROR_KINDS.NOT_KEYCLOAK,
  );
  keycloak.down = true;
  assert.equal(await kindOf(() => clientOf(keycloak).userCount('home')), ERROR_KINDS.UNREACHABLE);
  const tls = clientOf(keycloak, {
    request: async () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
      throw err;
    },
  });
  assert.equal(await kindOf(() => tls.userCount('home')), ERROR_KINDS.TLS);
});

test('sessions, lockouts, user names and version', async () => {
  const keycloak = new FakeKeycloak();
  const client = clientOf(keycloak);
  assert.equal(await client.sessionCount('home'), 1);
  assert.equal(await client.isLocked('home', BOB), true);
  assert.equal(await client.isLocked('home', 'someone-else'), false);
  assert.equal(await client.username('home', BOB), 'bob');
  assert.equal(await client.username('home', 'deleted'), '');
  assert.equal(await client.version(), '26.4.7');
  keycloak.showVersion = false;
  assert.equal(await client.version(), '');
});
