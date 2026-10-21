// -----------------------------------------------------------------------------
// The Keycloak hub: the admin API read on a timer of the container (the
// interval chosen in the configuration), realm after realm; the states of the
// devices published when they change, the scene events fired for each new
// security event, and the views the widget and the scene action read.
//
// Events: the user events (logins, failed logins, lockouts) and the admin
// events (users, roles, clients, realm) of the last 24 hours are read at the
// first read, then, at each read, those since the latest event already seen
// (`dateFrom`). They are kept in memory for the counts and the widget. Per
// realm, the time of the latest event seen and the ids around it are kept in
// /data (src/store.js): what happened while the integration restarted is
// still announced, once, and nothing twice.
//
// Gladys never polls the devices (should_poll: false): the interval goes up to
// 5 minutes, beyond the fixed list of the core scheduler, and the scene events
// must fire whether a device is added or not.
//
// User names and addresses are personal data: they go to the scene events
// (variables, for a notification) and to the widget, never to the info logs.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { buildRealmDevice, realmIds, realmValues } from './devices.js';
import { KeycloakClient, KeycloakError } from './keycloak/client.js';
import { hostOf, normalizeConfig } from './config.js';
import { ProblemLog } from './problems.js';
import { CONNECTION_TEXT, ERROR_TEXT, PARTIAL_TEXT, REPORT_TEXT, labelled, pick } from './texts.js';

const logger = createLogger({ name: 'keycloak-hub' });

export const WIDGET_KEY = 'security_events';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  LOGIN_FAILED: 'login_failed',
  LOGIN_FAILURES_BURST: 'login_failures_burst',
  ACCOUNT_LOCKED: 'account_locked',
  ADMIN_EVENT: 'admin_event',
});

// The kinds of the "Sensitive admin event" trigger (its `kind` filter), see
// adminKind() in src/keycloak/client.js.
export const ADMIN_EVENT_KINDS = Object.freeze([
  'admin_role_granted',
  'role_granted',
  'user_created',
  'user_deleted',
  'client_changed',
  'realm_changed',
]);

export const HUB_TIMINGS = {
  // An unchanged value is sent again this often: Gladys shows "no recent
  // value" after 48 hours.
  heartbeatMs: 12 * 3600_000,
  // A scene action reads Keycloak again when the last read is older.
  freshMs: 15_000,
  // The users and the version move slowly: read this often.
  usersMs: 10 * 60_000,
  versionMs: 3600_000,
};

export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;

// Events are read again this far before the latest one seen: an event written
// a little late by another node of Keycloak is not missed (the ids sort out
// the repeats).
export const OVERLAP_MS = 2 * 60_000;

// Pages of 100 events read at most, per realm and kind: at the first read (24
// hours), then at each read. Beyond, the counts are lower bounds.
export const FIRST_MAX_PAGES = 30;
export const MAX_PAGES = 10;

// Failed reads in a row before a realm counts as unreachable (a restart of
// Keycloak goes unnoticed).
export const FAILURES_BEFORE_UNREACHABLE = 2;

// Scene events per trigger and per read, at most: a brute-force attack must
// not send hundreds of notifications.
export const MAX_EVENTS_PER_READ = 10;

// Scene events refused by Gladys kept for the next read, at most.
export const MAX_UNSENT = 50;

// Locked accounts checked again per realm and per read, at most (one request
// each).
export const MAX_LOCK_CHECKS = 20;

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value) => (Number.isFinite(value) ? value : 0);
const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];

/** What the hub knows of one realm, in memory. */
function newRealm(name) {
  return {
    name,
    /** @type {Map<string, object>} user events of the last 24 hours, by id */
    events: new Map(),
    /** @type {Map<string, object>} admin events of the last 24 hours, by id */
    admin: new Map(),
    loaded: false,
    complete: true,
    readAt: 0,
    error: null,
    failures: 0,
    burstArmed: true,
    users: null,
    usersAt: 0,
    sessions: null,
    /** @type {Record<string, object|null>} errors of the secondary endpoints */
    partial: { users: null, sessions: null, locks: null },
  };
}

function emptySavedRealm() {
  return {
    initialized: false,
    reachable: null,
    cursor: 0,
    recent: [],
    adminCursor: 0,
    adminRecent: [],
    locked: [],
  };
}

function loadSavedRealm(raw) {
  const saved = object(raw);
  return {
    initialized: saved.initialized === true,
    reachable: typeof saved.reachable === 'boolean' ? saved.reachable : null,
    cursor: finite(saved.cursor),
    recent: strings(saved.recent),
    adminCursor: finite(saved.adminCursor),
    adminRecent: strings(saved.adminRecent),
    locked: strings(saved.locked),
  };
}

const newest = (map) => {
  let time = 0;
  for (const event of map.values()) {
    time = Math.max(time, event.time);
  }
  return time;
};

export class KeycloakHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/keycloak/client.js)
   * @param {boolean} [options.timers] the reading timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    // Defaults until start(): a handler reached after a failed start still
    // answers with a readable message.
    this.config = normalizeConfig({});
    this.client = null;
    this.signature = null;
    this.resetReads();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.saved = { url: null, realms: {} };
    /** @type {Array<[string, object]>} scene events Gladys refused, to send again */
    this.unsent = [];
    this.pollTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.problems = new ProblemLog(logger);
  }

  /** Forget everything read from Keycloak (another address or client). */
  resetReads() {
    /** @type {Map<string, ReturnType<typeof newRealm>>} */
    this.realms = new Map(this.config.realms.map((name) => [name, newRealm(name)]));
    this.polling = null;
    this.version = null;
    this.versionAt = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = object(await this.store.load());
    const realms = {};
    for (const [name, raw] of Object.entries(object(saved.realms))) {
      realms[name] = loadSavedRealm(raw);
    }
    this.saved = { url: typeof saved.url === 'string' ? saved.url : null, realms };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.signature !== null && this.config.language !== config.language;
    this.config = config;
    const signature = JSON.stringify([
      config.url,
      config.realms,
      config.clientRealm,
      config.clientId,
      config.clientSecret,
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.client =
        config.url && config.realms.length > 0 && config.clientId && config.clientSecret
          ? new KeycloakClient({
              url: config.url,
              authRealm: config.clientRealm,
              clientId: config.clientId,
              clientSecret: config.clientSecret,
              request: this.request,
              now: this.now,
            })
          : null;
      // A read of the previous client in progress must not be reused.
      this.resetReads();
      this.discovered = null;
      // Another server: what was saved about the previous one means nothing.
      if (config.url && this.saved.url !== config.url) {
        this.saved = { url: config.url, realms: {} };
        this.unsent = [];
      }
      for (const name of config.realms) {
        this.saved.realms[name] ??= emptySavedRealm();
      }
    }
    if (languageChanged) {
      this.discovered = null; // new feature names for the Discovery tab
    }
    try {
      if (this.client) {
        await this.pollNow({ publish: true });
      } else {
        await this.afterChanges(true, { publish: true });
      }
    } finally {
      this.schedulePoll();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollNow();
        this.problems.recover('poll', 'Reading Keycloak works again');
      } catch (err) {
        this.problems.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Reading Keycloak ------------------------------------------------------

  /** Read Keycloak now and publish what changed. */
  async pollNow({ publish = false } = {}) {
    const changed = await this.poll();
    await this.afterChanges(changed, { publish });
  }

  /** Read again when the last read is older than `freshMs` (scene actions). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt() >= this.timings.freshMs) {
      await this.pollNow();
    }
  }

  /** Time of the latest read (success or failure) of any realm. */
  readAt() {
    let at = 0;
    for (const realm of this.realms.values()) {
      at = Math.max(at, realm.readAt);
    }
    return at;
  }

  /**
   * Read Keycloak and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll() {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (!this.polling) {
      const polling = this.read(this.client).finally(() => {
        // A read of a previous client must not drop the promise of the current one.
        if (this.polling === polling) {
          this.polling = null;
        }
      });
      this.polling = polling;
    }
    return this.polling;
  }

  async read(client) {
    const sceneEvents = [];
    let changed = false;
    let tokenError = null;
    try {
      await client.ensureToken();
    } catch (err) {
      if (!(err instanceof KeycloakError)) {
        throw err;
      }
      tokenError = err;
    }
    for (const realm of this.realms.values()) {
      if (client !== this.client) {
        return false;
      }
      changed = (await this.readRealm(client, realm, sceneEvents, tokenError)) || changed;
    }
    if (client !== this.client) {
      return false;
    }
    const now = this.now();
    if (!tokenError && (this.versionAt === 0 || now - this.versionAt >= this.timings.versionMs)) {
      this.versionAt = now;
      try {
        // '' for a client outside master: Keycloak hides its version then.
        const version = await client.version();
        if (client !== this.client) {
          return false;
        }
        changed = changed || version !== this.version;
        this.version = version;
      } catch (err) {
        if (!(err instanceof KeycloakError)) {
          throw err;
        }
        logger.debug(`Keycloak version: ${err.message}`);
      }
    }
    await this.fireAll(sceneEvents);
    if (client === this.client) {
      await this.publishStates();
    }
    return changed || sceneEvents.length > 0;
  }

  /** @returns {Promise<boolean>} whether the widget shows something new */
  async readRealm(client, realm, sceneEvents, tokenError) {
    if (tokenError) {
      return this.applyFailure(realm, tokenError);
    }
    const now = this.now();
    const sinceLast = (map) =>
      realm.loaded && newest(map) ? Math.max(newest(map) - OVERLAP_MS, now - DAY_MS) : now - DAY_MS;
    const pages = realm.loaded ? MAX_PAGES : FIRST_MAX_PAGES;
    let user;
    let admin;
    try {
      user = await client.userEvents(realm.name, sinceLast(realm.events), pages);
      admin = await client.adminEvents(realm.name, sinceLast(realm.admin), pages);
    } catch (err) {
      if (!(err instanceof KeycloakError)) {
        throw err;
      }
      return client === this.client && this.applyFailure(realm, err);
    }
    if (client !== this.client) {
      return false;
    }
    const sessions = await this.secondary(realm, 'sessions', client, () =>
      client.sessionCount(realm.name),
    );
    const users =
      realm.usersAt === 0 || now - realm.usersAt >= this.timings.usersMs
        ? await this.secondary(realm, 'users', client, () => client.userCount(realm.name))
        : undefined;
    if (client !== this.client) {
      return false;
    }
    return this.applySuccess(realm, client, { user, admin, sessions, users }, sceneEvents);
  }

  /**
   * One of the endpoints besides the events: a failure (a role left out) is
   * kept apart, the rest still counts.
   * @returns {Promise<unknown|null>} null on failure
   */
  async secondary(realm, key, client, fn) {
    try {
      const value = await fn();
      if (client !== this.client) {
        return null; // a read of the previous client: its news are stale
      }
      if (realm.partial[key]) {
        logger.info(`Keycloak ${realm.name} ${key} can be read again`);
      }
      realm.partial[key] = null;
      return value;
    } catch (err) {
      if (!(err instanceof KeycloakError)) {
        throw err;
      }
      if (client !== this.client) {
        return null;
      }
      if (realm.partial[key]?.kind !== err.kind) {
        logger.warn(`Keycloak ${realm.name} ${key}: ${err.message}`);
      }
      realm.partial[key] = { kind: err.kind, message: err.message };
      return null;
    }
  }

  savedOf(realm) {
    this.saved.realms[realm.name] ??= emptySavedRealm();
    return this.saved.realms[realm.name];
  }

  /** Whether a realm counts as reachable (after a few failed reads in a row). */
  isReachable(realm) {
    return realm.loaded && this.savedOf(realm).reachable !== false;
  }

  /**
   * Whether to show the failure of a realm: after FAILURES_BEFORE_UNREACHABLE
   * reads in a row (a restart of Keycloak goes unnoticed, as for
   * "Reachable"), at once when nothing was ever read (wrong realm or client).
   */
  isFailing(realm) {
    return realm.error !== null && (realm.failures >= FAILURES_BEFORE_UNREACHABLE || !realm.loaded);
  }

  /** Whether any realm can be read. */
  get reachable() {
    return [...this.realms.values()].some((realm) => this.isReachable(realm));
  }

  /** The failure to show for Keycloak as a whole: every realm failing. */
  get failing() {
    const realms = [...this.realms.values()];
    return realms.length > 0 && realms.every((realm) => this.isFailing(realm));
  }

  /** The error of the first failing realm ({ kind, message, realm }), null when none. */
  get error() {
    const realm = [...this.realms.values()].find((state) => this.isFailing(state));
    return realm ? { ...realm.error, realm: realm.name } : null;
  }

  /**
   * Merge newly read events into `map`. New: not seen yet in this process; at
   * its first read, those after the cursor saved (what happened during a
   * restart), the ids saved with it sorting out the overlap.
   * @returns {{ added: object[], fresh: object[], changed: boolean, cursor: number,
   *   recent: string[] }}
   */
  merge(realm, map, events, { firstRead, cursor, recent, initialized }) {
    const now = this.now();
    const seen = new Set(recent);
    const added = [];
    const fresh = [];
    let changed = false;
    for (const event of events) {
      if (map.has(event.id)) {
        continue;
      }
      map.set(event.id, { ...event, realm: realm.name });
      added.push(map.get(event.id));
      changed = true;
      const isNews = !firstRead || (event.time >= cursor - OVERLAP_MS && !seen.has(event.id));
      if (initialized && isNews) {
        fresh.push(map.get(event.id));
      }
    }
    for (const [id, event] of map) {
      if (event.time < now - DAY_MS) {
        map.delete(id);
        changed = true;
      }
    }
    fresh.sort((a, b) => a.time - b.time);
    // The cursor: the latest event, and the ids at most OVERLAP_MS older.
    const nextCursor = Math.max(cursor, newest(map));
    const nextRecent = [...map.values()]
      .filter((event) => event.time >= nextCursor - OVERLAP_MS)
      .map((event) => event.id)
      .sort();
    return { added, fresh, changed, cursor: nextCursor, recent: nextRecent };
  }

  async applySuccess(realm, client, { user, admin, sessions, users }, sceneEvents) {
    const saved = this.savedOf(realm);
    const savedRoot = this.saved;
    const config = this.config;
    const now = this.now();
    const firstRead = !realm.loaded;
    const initialized = saved.initialized;
    let widgetChanged = realm.error !== null || firstRead;
    let dirty = saved.reachable !== true || !initialized;
    if (realm.error && this.isFailing(realm)) {
      logger.info(`Keycloak realm ${realm.name} can be read again`);
    }
    realm.error = null;
    realm.failures = 0;
    saved.reachable = true;
    realm.readAt = now;

    const complete = user.complete && admin.complete;
    if (!complete && realm.complete) {
      logger.info(
        `More than ${(firstRead ? FIRST_MAX_PAGES : MAX_PAGES) * 100} events at once in ${realm.name}: counts are lower bounds`,
      );
    }
    realm.complete = complete;

    const userMerge = this.merge(realm, realm.events, user.events, {
      firstRead,
      cursor: saved.cursor,
      recent: saved.recent,
      initialized,
    });
    const adminMerge = this.merge(realm, realm.admin, admin.events, {
      firstRead,
      cursor: saved.adminCursor,
      recent: saved.adminRecent,
      initialized,
    });
    realm.loaded = true;
    widgetChanged = widgetChanged || userMerge.changed || adminMerge.changed;
    for (const [key, merged] of [
      ['', userMerge],
      ['admin', adminMerge],
    ]) {
      const cursorKey = key ? 'adminCursor' : 'cursor';
      const recentKey = key ? 'adminRecent' : 'recent';
      if (merged.cursor !== saved[cursorKey]) {
        saved[cursorKey] = merged.cursor;
        dirty = true;
      }
      if (JSON.stringify(merged.recent) !== JSON.stringify([...saved[recentKey]].sort())) {
        saved[recentKey] = merged.recent;
        dirty = true;
      }
    }

    const counts = new Map();
    const capped = (key, data) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count <= MAX_EVENTS_PER_READ) {
        sceneEvents.push([key, data]);
      }
    };

    // Each new event, in the order it happened.
    const locked = new Set(saved.locked);
    const lockouts = [];
    for (const event of userMerge.fresh) {
      if (event.type === 'LOGIN_ERROR') {
        capped(TRIGGERS.LOGIN_FAILED, {
          realm: realm.name,
          username: event.username,
          ip: event.ip,
          client: event.client,
          error: event.error,
        });
      } else if (event.lockout) {
        lockouts.push(event);
      }
    }
    // Lockouts read but not news (the first read): the accounts count as
    // locked, without announcing them; the check below sorts out the ended
    // ones.
    const freshSet = new Set(userMerge.fresh);
    for (const event of userMerge.added) {
      if (event.lockout && event.userId && !freshSet.has(event)) {
        locked.add(event.userId);
      }
    }
    for (const event of adminMerge.fresh) {
      capped(TRIGGERS.ADMIN_EVENT, {
        realm: realm.name,
        kind: event.kind,
        operation: event.operation,
        resource: event.resource,
        target: event.target,
        ip: event.ip,
      });
    }

    // A series of failed logins: once when the count over the window reaches
    // the threshold with a new failure, again only after it fell below.
    const windowStart = now - config.burstWindowMs;
    const inWindow = [...realm.events.values()]
      .filter((event) => event.type === 'LOGIN_ERROR' && event.time >= windowStart)
      .sort((a, b) => a.time - b.time);
    const freshFailures = userMerge.fresh.filter((event) => event.type === 'LOGIN_ERROR');
    if (firstRead) {
      // After a restart, a series already under way was announced before.
      realm.burstArmed =
        inWindow.filter((event) => !freshSet.has(event)).length < config.burstCount;
    }
    if (inWindow.length < config.burstCount) {
      realm.burstArmed = true;
    } else if (realm.burstArmed && freshFailures.length > 0) {
      realm.burstArmed = false;
      const last = inWindow[inWindow.length - 1];
      sceneEvents.push([
        TRIGGERS.LOGIN_FAILURES_BURST,
        {
          realm: realm.name,
          count: inWindow.length,
          window_minutes: config.burstWindowMs / 60_000,
          usernames: new Set(inWindow.map((event) => event.username)).size,
          addresses: new Set(inWindow.map((event) => event.ip)).size,
          username: last.username,
          ip: last.ip,
        },
      ]);
    }

    if (sessions !== null) {
      realm.sessions = sessions;
    }
    if (users !== undefined) {
      realm.usersAt = now;
      if (users !== null) {
        realm.users = users;
      }
    }
    saved.initialized = true;

    // The accounts found locked before: still locked? (an administrator may
    // have unlocked them, a temporary lockout ends.) The new lockouts are
    // locked by definition.
    const toCheck = [...locked].slice(0, MAX_LOCK_CHECKS);
    for (const userId of toCheck) {
      const still = await this.secondary(realm, 'locks', client, () =>
        client.isLocked(realm.name, userId),
      );
      if (client !== this.client || savedRoot !== this.saved) {
        return false;
      }
      if (still === false) {
        locked.delete(userId);
      }
    }
    for (const event of lockouts) {
      if (!event.userId) {
        continue;
      }
      locked.add(event.userId);
      let username = this.usernameOf(realm, event.userId);
      if (!username) {
        username =
          (await this.secondary(realm, 'locks', client, () =>
            client.username(realm.name, event.userId),
          )) ?? '';
        if (client !== this.client || savedRoot !== this.saved) {
          return false;
        }
      }
      event.username = username;
      capped(TRIGGERS.ACCOUNT_LOCKED, {
        realm: realm.name,
        username,
        ip: event.ip,
        lockout: event.lockout,
      });
    }
    const nextLocked = [...locked].sort();
    if (JSON.stringify(nextLocked) !== JSON.stringify([...saved.locked].sort())) {
      saved.locked = nextLocked;
      dirty = true;
      widgetChanged = true;
    }

    // Written only when something changed: no wear of the SD card at every read.
    if (dirty) {
      this.store.save(this.saved);
    }
    const skipped = [...counts.values()].reduce(
      (sum, count) => sum + Math.max(0, count - MAX_EVENTS_PER_READ),
      0,
    );
    if (skipped > 0) {
      logger.info(
        `${skipped} scene event(s) skipped in ${realm.name}: more than ${MAX_EVENTS_PER_READ} at once`,
      );
    }
    return widgetChanged;
  }

  /** The user name of the latest failed login of an account, '' if none. */
  usernameOf(realm, userId) {
    let best = null;
    for (const event of realm.events.values()) {
      if (event.userId === userId && event.username && (!best || event.time > best.time)) {
        best = event;
      }
    }
    return best?.username ?? '';
  }

  /** Send the scene events, after those Gladys refused before. */
  async fireAll(sceneEvents) {
    // The cursors are already saved: an event Gladys refused (restarting,
    // 429) is kept and sent again at the next read.
    const saved = this.saved;
    const queue = [...this.unsent, ...sceneEvents];
    this.unsent = [];
    for (let i = 0; i < queue.length; i += 1) {
      if (saved !== this.saved) {
        return; // another server meanwhile: the old one's news are stale
      }
      const [key, data] = queue[i];
      logger.debug(`Scene event ${key}: ${JSON.stringify(data)}`);
      if (!(await this.fire(key, data))) {
        this.unsent = queue.slice(i, i + MAX_UNSENT);
        break;
      }
    }
  }

  async applyFailure(realm, err) {
    const wasError = realm.error?.kind;
    realm.error = { kind: err.kind, message: err.message };
    realm.failures += 1;
    realm.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`Keycloak ${realm.name}: ${err.message}`);
    }
    const saved = this.savedOf(realm);
    if (realm.failures >= FAILURES_BEFORE_UNREACHABLE && saved.reachable !== false) {
      const wasReachable = saved.reachable === true;
      saved.reachable = false;
      this.store.save(this.saved);
      if (wasReachable) {
        logger.info(`Keycloak realm ${realm.name} is unreachable`);
      }
    }
    return wasError !== err.kind;
  }

  // --- Views -----------------------------------------------------------------

  /** Counts of the last 24 hours, of one realm or of all. */
  counts(realm = null) {
    const now = this.now();
    let failed1h = 0;
    let failed24h = 0;
    let logins24h = 0;
    let locked = 0;
    let users = null;
    let sessions = null;
    const add = (sum, value) => (Number.isInteger(value) ? (sum ?? 0) + value : sum);
    for (const state of realm ? [realm] : this.realms.values()) {
      if (!this.isReachable(state)) {
        continue;
      }
      for (const event of state.events.values()) {
        if (event.time < now - DAY_MS) {
          continue;
        }
        if (event.type === 'LOGIN_ERROR') {
          failed24h += 1;
          if (event.time >= now - HOUR_MS) {
            failed1h += 1;
          }
        } else if (event.type === 'LOGIN') {
          logins24h += 1;
        }
      }
      locked += this.savedOf(state).locked.length;
      users = add(users, state.users);
      sessions = add(sessions, state.sessions);
    }
    return { failed1h, failed24h, logins24h, locked, users, sessions };
  }

  /** The events of every realm (user and admin), latest first. */
  latestEvents(count = Infinity) {
    const all = [];
    for (const realm of this.realms.values()) {
      all.push(...realm.events.values(), ...realm.admin.values());
    }
    return all.sort((a, b) => b.time - a.time).slice(0, count);
  }

  /** The latest failed login of any realm, null when none in 24 hours. */
  latestFailure() {
    return this.latestEvents().find((event) => event.type === 'LOGIN_ERROR') ?? null;
  }

  /** @returns {Promise<boolean>} whether Gladys accepted the event */
  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.problems.recover('event', 'Scene events accepted again');
      return true;
    } catch (err) {
      this.problems.fail('event', `Scene event ${key} refused: ${err.message}`);
      return false;
    }
  }

  // --- Publishing to Gladys --------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /** Publish the Discovery list when it changed (a language, a realm…). */
  async publishDevices({ force = false } = {}) {
    let devices;
    if (!this.client) {
      devices = [];
    } else if (this.reachable) {
      devices = [...this.realms.values()]
        .filter((realm) => realm.loaded)
        .map((realm) =>
          buildRealmDevice(this.gladys, realm.name, { language: this.config.language }),
        );
    } else {
      return; // nothing read: keep the list Gladys has
    }
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read Keycloak, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.afterChanges(true, { publish: true });
  }

  /**
   * The user added (or updated) a device: its states sent before were
   * dropped by Gladys, and a device deleted then added again needs its badge.
   */
  async onDeviceCreated() {
    this.transports = new Map();
    await this.publishStates();
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Gladys asks for a refresh (onPoll, only if it polls anyway). */
  async pollDevice() {
    await this.pollNow();
  }

  /**
   * The states of the devices added. The SDK skips the values Gladys already
   * has (and sends an unchanged one again after `heartbeatMs`).
   */
  async publishStates() {
    const states = [];
    for (const realm of this.realms.values()) {
      if (realm.readAt === 0 || !this.isCreated(realmIds(this.gladys, realm.name).device)) {
        continue;
      }
      states.push(
        ...realmValues(this.gladys, realm.name, {
          reachable: this.isReachable(realm),
          ...this.counts(realm),
          version: this.version ?? '',
        }),
      );
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of each device: local, or unreachable. */
  async publishTransports() {
    if (!this.client) {
      return;
    }
    const changes = [];
    for (const realm of this.realms.values()) {
      const externalId = realmIds(this.gladys, realm.name).device;
      if (realm.readAt === 0 || !this.isCreated(externalId)) {
        continue;
      }
      const transport = this.isReachable(realm)
        ? DEVICE_TRANSPORTS.LOCAL
        : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        changes.push({ external_id: externalId, transport });
      }
    }
    if (changes.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(changes);
      for (const change of changes) {
        this.transports.set(change.external_id, change.transport);
      }
      this.problems.recover('transports', 'Transports accepted again');
    } catch (err) {
      this.problems.fail('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (this.config.url === '') {
      return { connected: false, message: CONNECTION_TEXT.noUrl };
    }
    if (!this.config.url) {
      return { connected: false, message: CONNECTION_TEXT.invalidUrl };
    }
    if (this.config.realms.length === 0) {
      return { connected: false, message: CONNECTION_TEXT.noRealm };
    }
    if (!this.config.clientId || !this.config.clientSecret) {
      return { connected: false, message: CONNECTION_TEXT.noClient };
    }
    if (this.failing) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      if (status.connected) {
        logger.info(`Connected to Keycloak (${hostOf(this.config.url)})`);
      }
      this.problems.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.problems.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  /** Throws the reason Keycloak cannot answer, if any. */
  assertReadable() {
    const status = this.connectionStatus();
    if (!status.connected) {
      throw new Error(pick(status.message, this.config.language));
    }
  }

  /** One realm in words: its counts, or why it cannot be read. */
  realmSummary(realm, language) {
    const text = pick(REPORT_TEXT, language);
    if (this.isFailing(realm)) {
      return pick(ERROR_TEXT[realm.error.kind], language);
    }
    if (!this.isReachable(realm)) {
      return text.unreachable;
    }
    const { failed1h, failed24h, logins24h, locked, users } = this.counts(realm);
    const parts = [text.failed(failed1h, failed24h), text.logins(logins24h)];
    if (locked > 0) {
      parts.push(text.locked(locked));
    }
    if (Number.isInteger(users)) {
      parts.push(text.users(users));
    }
    for (const [key, error] of Object.entries(realm.partial)) {
      if (error) {
        parts.push(pick(PARTIAL_TEXT[key], language));
      }
    }
    return parts.join(', ');
  }

  /** The summary of "Test the connection" and of "Keycloak state". */
  summary(language) {
    const status = this.connectionStatus();
    if (!status.connected) {
      return pick(status.message, language);
    }
    const realms = [...this.realms.values()];
    if (realms.length === 1) {
      return labelled('Keycloak', this.realmSummary(realms[0], language), language);
    }
    const parts = realms.map((realm) =>
      labelled(realm.name, this.realmSummary(realm, language), language),
    );
    return labelled('Keycloak', parts.join('; '), language);
  }

  /** "Test the connection": read Keycloak now, one line per language. */
  async testConnection() {
    await this.pollNow({ publish: true });
    const message = {};
    for (const language of Object.keys(REPORT_TEXT)) {
      const status = this.connectionStatus();
      message[language] =
        status.connected && this.reachable
          ? `${pick(REPORT_TEXT, language).ok(this.version)}. ${this.summary(language)}`
          : this.summary(language);
    }
    return message;
  }
}
