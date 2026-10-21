// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake Keycloak, a
// temporary /data and a manual clock, with the integration wired on top
// through registerHandlers. No timer runs: the tests read Keycloak with
// `world.hub.pollNow()`. (Adapted from guim31/gladys-authentik.)
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { realmIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import {
  ALICE,
  BASE,
  BOB,
  CLIENT_ID,
  CLIENT_SECRET,
  FIXTURES,
  FakeKeycloak,
} from './fakeKeycloak.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

// The fixtures were recorded on 21/10/2026 between 14:32 and 14:34 UTC.
export function createClock(start = Date.UTC(2026, 9, 21, 14, 40, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export async function createWorld({
  clock = createClock(),
  keycloak = new FakeKeycloak(),
  config = {},
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-keycloak-')),
  timings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({
    config: {
      url: BASE,
      realms: 'home',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      language: 'en',
      ...config,
    },
    devices,
  });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: keycloak.request,
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, keycloak, app, hub: app.hub, clock, dataDir };
}

export const idsOf = (world, realm = 'home') => realmIds(world.gladys, realm);

/** Add the discovered device in Gladys, as the user would. */
export async function createDevices(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
}

export { ALICE, BASE, BOB, CLIENT_ID, CLIENT_SECRET, FIXTURES, FakeKeycloak };
