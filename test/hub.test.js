// -----------------------------------------------------------------------------
// The hub against the SDK's fake Gladys and a fake Keycloak built on real
// answers: discovery, states, the scene events of each trigger, persistence
// across restarts, several realms, errors and partial failures, quiet logs,
// the widget, the scene action and the reading timer of the container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { KEYS } from '../src/devices.js';
import { MAX_EVENTS_PER_READ, TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import { ACTIONS } from '../src/widgets.js';
import {
  ALICE,
  BOB,
  CLIENT_SECRET,
  FakeKeycloak,
  createClock,
  createDevices,
  createWorld,
  idsOf,
} from './helpers/world.js';

const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const state = (world, key, realm = 'home') =>
  world.fake.lastState(idsOf(world, realm).feature(key));

/** A read one minute later, with what `fn` added to Keycloak meanwhile. */
async function later(world, fn = () => {}) {
  world.clock.advance(60_000);
  fn(world.clock.time - 30_000);
  await world.hub.pollNow();
}

async function captureLogs(t, level, fn) {
  const lines = [];
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const before = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = before;
  }
  return lines;
}

test('one device per realm in Discovery, nothing announced at the first read', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const [device] = world.fake.discoveredDevices;
  assert.equal(device.name, 'Keycloak home');
  assert.equal(device.should_poll, false);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    Object.values(KEYS),
  );
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.sceneEvents.length, 0, 'what is already there is not news');
  await later(world);
  assert.equal(world.fake.sceneEvents.length, 0);
});

test('the states at once when the device is added, then only the changes', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.equal(world.fake.states.length, 0, 'nothing published before the device is added');
  await createDevices(world);
  // The fixtures: 5 failed logins (ghost, bob ×4), alice's login, bob locked.
  assert.equal(state(world, KEYS.REACHABLE), 1);
  assert.equal(state(world, KEYS.FAILED_1H), 5);
  assert.equal(state(world, KEYS.FAILED_24H), 5);
  assert.equal(state(world, KEYS.LOGINS_24H), 1);
  assert.equal(state(world, KEYS.USERS), 2);
  assert.equal(state(world, KEYS.SESSIONS), 1);
  assert.equal(state(world, KEYS.LOCKED), 1);
  assert.equal(state(world, KEYS.VERSION), '26.4.7');
  assert.deepEqual(
    world.fake.transports.map((e) => e.transport),
    ['local'],
  );
  assert.ok(world.fake.widgetRefreshes.length > 0);

  const before = world.fake.states.length;
  await later(world);
  assert.equal(world.fake.states.length, before, 'nothing changed, nothing sent');
  await later(world, (at) => world.keycloak.add('LOGIN_ERROR', { at }));
  assert.equal(state(world, KEYS.FAILED_1H), 6);
  // An hour later, the first failures leave the 1 h count.
  world.clock.advance(3600_000);
  await world.hub.pollNow();
  assert.equal(state(world, KEYS.FAILED_1H), 0);
  assert.equal(state(world, KEYS.FAILED_24H), 6);
});

test('a failed login fires "Failed login" with the realm, user, address and client', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await later(world, (at) =>
    world.keycloak.add('LOGIN_ERROR', { at, username: 'mallory', userId: '', ip: '203.0.113.9' }),
  );
  assert.deepEqual(
    events(world, TRIGGERS.LOGIN_FAILED).map((event) => event.data),
    [
      {
        realm: 'home',
        username: 'mallory',
        ip: '203.0.113.9',
        client: 'test-app',
        error: 'invalid_user_credentials',
      },
    ],
  );
  // A successful login is no trigger (the device counts it).
  await later(world, (at) => world.keycloak.add('LOGIN', { at }));
  assert.equal(world.fake.sceneEvents.length, 1);
});

test('a series of failed logins fires once, then again only after a calm', async (t) => {
  const world = await createWorld({ config: { burst_count: 3, burst_window: '5' } });
  t.after(() => world.app.stop());
  world.clock.advance(10 * 60_000); // the failures of the fixtures out of the window
  await world.hub.pollNow();
  await later(world, (at) => {
    world.keycloak.add('LOGIN_ERROR', { at, username: 'alice' });
    world.keycloak.add('LOGIN_ERROR', { at: at + 1, username: 'bob', ip: '203.0.113.1' });
  });
  assert.equal(events(world, TRIGGERS.LOGIN_FAILURES_BURST).length, 0);
  await later(world, (at) => world.keycloak.add('LOGIN_ERROR', { at, username: 'carol' }));
  const [burst] = events(world, TRIGGERS.LOGIN_FAILURES_BURST);
  assert.deepEqual(burst.data, {
    realm: 'home',
    count: 3,
    window_minutes: 5,
    usernames: 3,
    addresses: 2,
    username: 'carol',
    ip: '198.51.100.20',
  });
  await later(world, (at) => world.keycloak.add('LOGIN_ERROR', { at }));
  assert.equal(events(world, TRIGGERS.LOGIN_FAILURES_BURST).length, 1, 'once per series');
  world.clock.advance(10 * 60_000);
  await world.hub.pollNow();
  for (let i = 0; i < 3; i += 1) {
    await later(world, (at) => world.keycloak.add('LOGIN_ERROR', { at }));
  }
  assert.equal(events(world, TRIGGERS.LOGIN_FAILURES_BURST).length, 2, 'a new series');
});

test('a lockout fires "Account locked" with the user name; the count follows', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  await later(world, (at) => {
    world.keycloak.add('LOGIN_ERROR', { at, username: 'alice', ip: '203.0.113.4' });
    world.keycloak.add('USER_DISABLED_BY_PERMANENT_LOCKOUT', {
      at: at + 1,
      userId: ALICE,
      ip: '203.0.113.4',
    });
    world.keycloak.locked.add(ALICE);
  });
  assert.deepEqual(
    events(world, TRIGGERS.ACCOUNT_LOCKED).map((event) => event.data),
    [{ realm: 'home', username: 'alice', ip: '203.0.113.4', lockout: 'permanent' }],
  );
  assert.equal(state(world, KEYS.LOCKED), 2);
  // bob's temporary lockout ends, an administrator unlocks alice.
  world.keycloak.locked.clear();
  await later(world);
  assert.equal(state(world, KEYS.LOCKED), 0);
  assert.equal(events(world, TRIGGERS.ACCOUNT_LOCKED).length, 1);
  // A lockout without a failure read before: the name is asked to Keycloak.
  await later(world, (at) =>
    world.keycloak.add('USER_DISABLED_BY_TEMPORARY_LOCKOUT', { at, userId: BOB }),
  );
  assert.equal(events(world, TRIGGERS.ACCOUNT_LOCKED)[1].data.username, 'bob');
});

test('"Sensitive admin event": admin role, user created or deleted, client, realm', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await later(world, (at) => {
    world.keycloak.addAdmin('CREATE', 'CLIENT_ROLE_MAPPING', {
      at,
      representation: [{ name: 'manage-users' }, { name: 'view-users' }],
    });
    world.keycloak.addAdmin('CREATE', 'USER', { at: at + 1, representation: { username: 'eve' } });
    world.keycloak.addAdmin('UPDATE', 'USER', { at: at + 2 }); // not followed
    world.keycloak.addAdmin('UPDATE', 'REALM', { at: at + 3 });
    world.keycloak.addAdmin('DELETE', 'CLIENT', { at: at + 4 });
    world.keycloak.addAdmin('CREATE', 'GROUP', { at: at + 5 }); // not read
  });
  assert.deepEqual(
    events(world, TRIGGERS.ADMIN_EVENT).map((event) => [event.data.kind, event.data.target]),
    [
      ['admin_role_granted', 'manage-users, view-users'],
      ['user_created', 'eve'],
      ['realm_changed', ''],
      ['client_changed', ''],
    ],
  );
  assert.deepEqual(events(world, TRIGGERS.ADMIN_EVENT)[0].data, {
    realm: 'home',
    kind: 'admin_role_granted',
    operation: 'CREATE',
    resource: 'CLIENT_ROLE_MAPPING',
    target: 'manage-users, view-users',
    ip: '198.51.100.5',
  });
});

test('a restart announces what happened meanwhile, once, and nothing twice', async (t) => {
  const clock = createClock();
  const keycloak = new FakeKeycloak();
  const first = await createWorld({ clock, keycloak });
  await later(first, (at) => keycloak.add('LOGIN_ERROR', { at, username: 'before' }));
  await first.app.stop();
  clock.advance(5 * 60_000);
  keycloak.add('LOGIN_ERROR', { at: clock.time - 60_000, username: 'during' });
  keycloak.addAdmin('DELETE', 'USER', { at: clock.time - 50_000 });
  const second = await createWorld({ clock, keycloak, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  assert.deepEqual(
    events(second, TRIGGERS.LOGIN_FAILED).map((event) => event.data.username),
    ['during'],
  );
  assert.equal(events(second, TRIGGERS.ADMIN_EVENT).length, 1);
  assert.equal(events(second, TRIGGERS.ACCOUNT_LOCKED).length, 0, 'bob was locked before');
  await later(second);
  assert.equal(second.fake.sceneEvents.length, 2);
});

test('a brute-force attack sends at most a few scene events per read', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.clock.advance(11 * 60_000); // the series of the fixtures is over
  await world.hub.pollNow();
  await later(world, (at) => {
    for (let i = 0; i < 40; i += 1) {
      world.keycloak.add('LOGIN_ERROR', { at: at + i, username: `user${i}` });
    }
  });
  assert.equal(events(world, TRIGGERS.LOGIN_FAILED).length, MAX_EVENTS_PER_READ);
  assert.equal(events(world, TRIGGERS.LOGIN_FAILURES_BURST).length, 1);
});

test('two realms: one device each, the realm in the events, one realm failing', async (t) => {
  const keycloak = new FakeKeycloak();
  keycloak.clientRealm = 'master';
  const world = await createWorld({
    keycloak,
    config: { realms: 'home, family, ghost', client_realm: 'master', language: 'fr' },
  });
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['Keycloak home', 'Keycloak family'],
  );
  assert.equal(world.fake.connectionStatus.connected, true, 'two realms of three answer');
  await later(world, (at) => keycloak.add('LOGIN_ERROR', { at, realm: 'family', username: 'kid' }));
  assert.deepEqual(events(world, TRIGGERS.LOGIN_FAILED)[0].data.realm, 'family');
  const ack = await world.fake.sceneAction('get_status', {});
  assert.match(ack.data.outputs.sentence, /^Keycloak : home : 5 échec\(s\)/);
  assert.match(ack.data.outputs.sentence, /family : 1 échec\(s\)/);
  assert.match(ack.data.outputs.sentence, /ghost : realm introuvable/);
  const widget = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'fr' });
  const texts = widget.data.content.components.filter((c) => c.type === 'text');
  assert.equal(texts[0].text, 'ghost : realm introuvable (attention aux majuscules)');
  const status = widget.data.content.components.find((c) => c.type === 'status');
  assert.match(status.items[0].value, /^échec · family · /);
});

test('a wrong secret: the reason under the integration name, no device', async (t) => {
  const world = await createWorld({ config: { client_secret: 'wrong' } });
  t.after(() => world.app.stop());
  assert.deepEqual(world.fake.connectionStatus, {
    connected: false,
    message: {
      en: 'client refused: id, secret or service account to check',
      fr: 'client refusé : identifiant, secret ou compte de service à vérifier',
      de: 'Client abgelehnt: ID, Geheimnis oder Dienstkonto prüfen',
      es: 'cliente rechazado: revise el id, el secreto o la cuenta de servicio',
    },
  });
  assert.deepEqual(world.fake.discoveredDevices, []);
});

test('missing configuration and unusable address are explained', async (t) => {
  for (const [config, word] of [
    [{ url: '' }, 'address'],
    [{ url: 'ftp://x' }, 'not understood'],
    [{ realms: ' , ' }, 'realm'],
    [{ client_secret: '' }, 'client id and secret'],
  ]) {
    const world = await createWorld({ config });
    t.after(() => world.app.stop());
    assert.equal(world.fake.connectionStatus.connected, false);
    assert.match(world.fake.connectionStatus.message.en, new RegExp(word));
    const ack = await world.fake.sceneAction('get_status', {});
    assert.equal(ack.success, false, 'the scene action says what to fix');
  }
});

test('Keycloak down: unreachable after two failed reads, back when it answers', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.keycloak.down = true;
  await later(world);
  assert.equal(state(world, KEYS.REACHABLE), 1, 'one failed read goes unnoticed');
  assert.equal(world.fake.connectionStatus.connected, true);
  await later(world);
  assert.equal(state(world, KEYS.REACHABLE), 0);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  world.keycloak.down = false;
  await later(world);
  assert.equal(state(world, KEYS.REACHABLE), 1);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('a role left out: the rest still works, the report says what is missing', async (t) => {
  const keycloak = new FakeKeycloak();
  keycloak.forbidden.add('/users/count');
  keycloak.showVersion = false;
  const world = await createWorld({ keycloak });
  t.after(() => world.app.stop());
  await createDevices(world);
  assert.equal(state(world, KEYS.FAILED_24H), 5);
  assert.equal(state(world, KEYS.USERS), undefined);
  assert.equal(state(world, KEYS.VERSION), undefined, 'hidden outside master');
  const ack = await world.fake.action('test_connection', {});
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /^Connected \(version hidden outside master\)/);
  assert.match(ack.data.message.en, /users not readable \(role\?\)/);
  // Without view-events, the realm itself cannot be read.
  keycloak.forbidden.add('/events');
  await later(world);
  await later(world);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /role missing/);
});

test('a normal reading cycle writes nothing at the info level, nor any name or address', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const lines = await captureLogs(t, 'info', async () => {
    await later(world);
    await later(world, (at) =>
      world.keycloak.add('LOGIN_ERROR', { at, username: 'bob', ip: '198.51.100.77' }),
    );
    await later(world, (at) => world.keycloak.add('LOGIN', { at, username: 'bob' }));
    world.keycloak.revokeTokens(); // a token renewed is no news either
    await later(world);
  });
  assert.deepEqual(lines, []);
  const outage = await captureLogs(t, 'info', async () => {
    world.keycloak.down = true;
    await later(world);
    await later(world);
    await later(world);
  });
  assert.equal(outage.length, 2, 'one line when it fails, one when it is unreachable');
  assert.ok(
    !outage.some((line) => line.includes(CLIENT_SECRET) || /token-\d/.test(line)),
    'no secret in the logs',
  );
});

test('the widget: tiles, the latest events, the Refresh button', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await later(world, (at) =>
    world.keycloak.addAdmin('CREATE', 'USER', { at, representation: { username: 'eve' } }),
  );
  const ack = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'fr' });
  assert.equal(ack.success, true, ack.error);
  const content = ack.data.content;
  assert.deepEqual(validateWidgetContent(content), []);
  const [failed, logins, locked, status, button] = content.components;
  assert.equal(failed.value, 5);
  assert.equal(logins.value, 1);
  assert.equal(locked.value, 1);
  assert.equal(status.items.length, 8);
  assert.equal(status.items[0].label, 'eve');
  assert.match(status.items[0].value, /^utilisateur créé · \d\d:\d\d$/);
  assert.equal(button.action.key, ACTIONS.REFRESH);
  const refreshed = await world.fake.widgetAction(WIDGET_KEY, ACTIONS.REFRESH, {});
  assert.equal(refreshed.success, true, refreshed.error);

  const empty = await createWorld({ keycloak: new FakeKeycloak({ events: [], adminEvents: [] }) });
  t.after(() => empty.app.stop());
  const nothing = await empty.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'de' });
  assert.ok(nothing.data.content.components.some((c) => /Keine Anmeldung/.test(c.text)));
});

test('"Keycloak state" returns the counts and a sentence', async (t) => {
  const world = await createWorld({ config: { language: 'fr' } });
  t.after(() => world.app.stop());
  const ack = await world.fake.sceneAction('get_status', {});
  assert.equal(ack.success, true, ack.error);
  const outputs = ack.data.outputs;
  assert.equal(outputs.failed_logins_24h, 5);
  assert.equal(outputs.locked_accounts, 1);
  assert.equal(outputs.last_failed_username, 'ghost');
  assert.equal(outputs.last_failed_ip, '192.0.2.10');
  assert.equal(
    outputs.sentence,
    'Keycloak : 5 échec(s) de connexion en 1 h, 5 en 24 h, 1 connexion(s) en 24 h, 1 compte(s) bloqué(s), 2 utilisateur(s).',
  );
  world.keycloak.down = true;
  world.clock.advance(60_000);
  await world.hub.pollNow();
  world.clock.advance(60_000);
  const down = await world.fake.sceneAction('get_status', {});
  assert.equal(down.data.outputs.reachable, false);
  assert.equal(down.data.outputs.sentence, 'Keycloak ne répond pas.');
});

test('the timer of the container reads Keycloak without onPoll', async (t) => {
  const world = await createWorld({ timers: true, config: { poll_interval: '30' } });
  t.after(() => world.app.stop());
  const before = world.keycloak.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  world.hub.config = { ...world.hub.config, pollIntervalMs: 20 };
  world.hub.schedulePoll();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(world.keycloak.requests.length > before, 'Keycloak read by the timer');
});

test('another address forgets what was saved about the previous server', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.ok(world.hub.saved.realms.home.cursor > 0);
  await world.hub.reconfigure({ ...world.hub.config, url: 'https://other.example.com' });
  assert.equal(world.hub.saved.realms.home.cursor, 0);
  assert.equal(world.hub.realms.get('home').events.size, 0);
});

test('a scene event Gladys refused is sent again at the next read', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const publish = world.gladys.publishSceneEvent.bind(world.gladys);
  let refuse = true;
  world.gladys.publishSceneEvent = async (key, data) => {
    if (refuse) {
      throw new Error('Gladys restarting');
    }
    return publish(key, data);
  };
  await later(world, (at) => world.keycloak.add('LOGIN_ERROR', { at, username: 'bob' }));
  assert.equal(events(world, TRIGGERS.LOGIN_FAILED).length, 0);
  refuse = false;
  await later(world);
  assert.deepEqual(
    events(world, TRIGGERS.LOGIN_FAILED).map((event) => event.data.username),
    ['bob'],
  );
  await later(world);
  assert.equal(events(world, TRIGGERS.LOGIN_FAILED).length, 1);
});

test('a series already announced is not announced again after a restart', async (t) => {
  const clock = createClock();
  const keycloak = new FakeKeycloak();
  const config = { burst_count: 6, burst_window: '15' };
  const first = await createWorld({ clock, keycloak, config });
  await later(first, (at) => keycloak.add('LOGIN_ERROR', { at }));
  assert.equal(events(first, TRIGGERS.LOGIN_FAILURES_BURST).length, 1);
  await first.app.stop();
  clock.advance(60_000);
  keycloak.add('LOGIN_ERROR', { at: clock.time - 1000 });
  const second = await createWorld({ clock, keycloak, config, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  assert.equal(events(second, TRIGGERS.LOGIN_FAILED).length, 1, 'the failure is news');
  assert.equal(events(second, TRIGGERS.LOGIN_FAILURES_BURST).length, 0, 'the series is not');
});

test('a realm name with odd characters makes a clean external id', async (t) => {
  const world = await createWorld({ config: { realms: 'home' } });
  t.after(() => world.app.stop());
  const { realmIds } = await import('../src/devices.js');
  assert.match(realmIds(world.gladys, 'Mon:Realm é').device, /:realm:Mon_3aRealm_20_e9$/);
});

test('a permanent lockout stays counted until the account is enabled again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.keycloak.locked.clear(); // bob's temporary lockout is over
  await later(world, (at) => {
    world.keycloak.add('USER_DISABLED_BY_PERMANENT_LOCKOUT', { at, userId: ALICE });
    world.keycloak.disabled.add(ALICE);
  });
  await later(world);
  assert.equal(state(world, KEYS.LOCKED), 1, 'the brute-force status no longer says it');
  world.keycloak.disabled.clear();
  await later(world);
  assert.equal(state(world, KEYS.LOCKED), 0);
});

test('Keycloak slower to start than the integration: not unreachable at once', async (t) => {
  const keycloak = new FakeKeycloak();
  keycloak.down = true;
  const world = await createWorld({ keycloak });
  t.after(() => world.app.stop());
  world.hub.gladys.devices.push({ external_id: idsOf(world).device });
  await world.hub.publishStates();
  assert.equal(state(world, KEYS.REACHABLE), undefined, 'one failure: nothing published');
  await later(world);
  assert.equal(state(world, KEYS.REACHABLE), 0);
});

test('the news of a realm read survive a configuration saved during the read', async (t) => {
  const world = await createWorld({ config: { realms: 'home, family' } });
  t.after(() => world.app.stop());
  const request = world.keycloak.request;
  let changed = false;
  world.hub.client.request = async (url, options) => {
    if (!changed && url.includes('/realms/family/events')) {
      changed = true;
      // The user saves a new secret while home is read.
      world.hub.reconfigure({ ...world.hub.config, clientSecret: CLIENT_SECRET + '-2' });
    }
    return request(url, options);
  };
  world.keycloak.add('LOGIN_ERROR', { at: world.clock.time + 1, username: 'mallory' });
  world.clock.advance(60_000);
  await world.hub.poll();
  assert.deepEqual(
    events(world, TRIGGERS.LOGIN_FAILED).map((event) => event.data.username),
    ['mallory'],
  );
});
