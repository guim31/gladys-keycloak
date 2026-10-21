// -----------------------------------------------------------------------------
// The Gladys devices, proposed in the Discovery tab (the user adds them):
//
//   one "Keycloak <realm>" device per realm watched:
//     reachable            input/binary    1 the realm can be read, 0 otherwise
//     failed_logins_1h     counter-sensor  failed logins in the last hour
//     failed_logins_24h    counter-sensor  failed logins in the last 24 hours
//     logins_24h           counter-sensor  successful logins in the last 24 h
//     users                counter-sensor  user accounts (service accounts
//                                          left out)
//     sessions             counter-sensor  active sessions, one per user and
//                                          application
//     locked_accounts      counter-sensor  accounts the brute-force
//                                          protection holds locked now
//     version              text/text       version of Keycloak (only for a
//                                          client of the master realm)
//
// Published with should_poll: false: the integration reads Keycloak on its
// own timer (src/hub.js), at the interval chosen in the configuration. The
// realm name is the platform id: renaming a realm makes another device.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

export const REALM_TYPE = 'realm';
export const MODEL = 'Keycloak realm';

// Suffixes of the feature external ids: permanent once published.
export const KEYS = Object.freeze({
  REACHABLE: 'reachable',
  FAILED_1H: 'failed_logins_1h',
  FAILED_24H: 'failed_logins_24h',
  LOGINS_24H: 'logins_24h',
  USERS: 'users',
  SESSIONS: 'sessions',
  LOCKED: 'locked_accounts',
  VERSION: 'version',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [KEYS.REACHABLE]: 'Reachable',
    [KEYS.FAILED_1H]: 'Failed logins (1 h)',
    [KEYS.FAILED_24H]: 'Failed logins (24 h)',
    [KEYS.LOGINS_24H]: 'Logins (24 h)',
    [KEYS.USERS]: 'Users',
    [KEYS.SESSIONS]: 'Active sessions',
    [KEYS.LOCKED]: 'Locked accounts',
    [KEYS.VERSION]: 'Version',
  },
  fr: {
    [KEYS.REACHABLE]: 'Joignable',
    [KEYS.FAILED_1H]: 'Échecs de connexion (1 h)',
    [KEYS.FAILED_24H]: 'Échecs de connexion (24 h)',
    [KEYS.LOGINS_24H]: 'Connexions (24 h)',
    [KEYS.USERS]: 'Utilisateurs',
    [KEYS.SESSIONS]: 'Sessions actives',
    [KEYS.LOCKED]: 'Comptes bloqués',
    [KEYS.VERSION]: 'Version',
  },
  de: {
    [KEYS.REACHABLE]: 'Erreichbar',
    [KEYS.FAILED_1H]: 'Fehlgeschlagene Anmeldungen (1 h)',
    [KEYS.FAILED_24H]: 'Fehlgeschlagene Anmeldungen (24 h)',
    [KEYS.LOGINS_24H]: 'Anmeldungen (24 h)',
    [KEYS.USERS]: 'Benutzer',
    [KEYS.SESSIONS]: 'Aktive Sitzungen',
    [KEYS.LOCKED]: 'Gesperrte Konten',
    [KEYS.VERSION]: 'Version',
  },
  es: {
    [KEYS.REACHABLE]: 'Accesible',
    [KEYS.FAILED_1H]: 'Inicios de sesión fallidos (1 h)',
    [KEYS.FAILED_24H]: 'Inicios de sesión fallidos (24 h)',
    [KEYS.LOGINS_24H]: 'Inicios de sesión (24 h)',
    [KEYS.USERS]: 'Usuarios',
    [KEYS.SESSIONS]: 'Sesiones activas',
    [KEYS.LOCKED]: 'Cuentas bloqueadas',
    [KEYS.VERSION]: 'Versión',
  },
};

// Display bounds (the core never applies them on write).
export const MAX_EVENTS = 100_000;
export const MAX_USERS = 1_000_000;

/**
 * The platform id of a realm: its name, any character outside
 * [A-Za-z0-9._-] written `_<hex code>` (a ':' would split the external id).
 */
export const realmPlatformId = (realm) =>
  realm.replace(/[^A-Za-z0-9._-]/g, (char) => `_${char.codePointAt(0).toString(16)}`);

export const realmIds = (gladys, realm) => gladys.externalIds(REALM_TYPE, realmPlatformId(realm));

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

const counter = (name, externalId, max) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    { keep_history: true, min: 0, max },
  );

/** The discovery payload of a realm. */
export function buildRealmDevice(gladys, realm, { language = 'en' } = {}) {
  const ids = realmIds(gladys, realm);
  const names = NAMES[language] ?? NAMES.en;
  const feature = (key) => ids.feature(key);
  return {
    name: `Keycloak ${realm}`,
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: [
      sensor(
        names[KEYS.REACHABLE],
        feature(KEYS.REACHABLE),
        DEVICE_FEATURE_CATEGORIES.INPUT,
        DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        { keep_history: true, min: 0, max: 1 },
      ),
      counter(names[KEYS.FAILED_1H], feature(KEYS.FAILED_1H), MAX_EVENTS),
      counter(names[KEYS.FAILED_24H], feature(KEYS.FAILED_24H), MAX_EVENTS),
      counter(names[KEYS.LOGINS_24H], feature(KEYS.LOGINS_24H), MAX_EVENTS),
      counter(names[KEYS.USERS], feature(KEYS.USERS), MAX_USERS),
      counter(names[KEYS.SESSIONS], feature(KEYS.SESSIONS), MAX_USERS),
      counter(names[KEYS.LOCKED], feature(KEYS.LOCKED), MAX_USERS),
      sensor(
        names[KEYS.VERSION],
        feature(KEYS.VERSION),
        DEVICE_FEATURE_CATEGORIES.TEXT,
        DEVICE_FEATURE_TYPES.TEXT.TEXT,
        { keep_history: false, min: 0, max: 0 },
      ),
    ],
  };
}

/**
 * The values of a realm device: only "reachable" when the realm cannot be
 * read (the counts keep their last value). A null count is unknown (its
 * endpoint failed, a role missing): not sent.
 * @param {object} view { reachable, failed1h, failed24h, logins24h, users,
 *   sessions, locked, version }
 */
export function realmValues(gladys, realm, view) {
  const ids = realmIds(gladys, realm);
  const values = [{ key: KEYS.REACHABLE, state: view.reachable ? 1 : 0 }];
  if (view.reachable) {
    const counts = [
      [KEYS.FAILED_1H, view.failed1h],
      [KEYS.FAILED_24H, view.failed24h],
      [KEYS.LOGINS_24H, view.logins24h],
      [KEYS.USERS, view.users],
      [KEYS.SESSIONS, view.sessions],
      [KEYS.LOCKED, view.locked],
    ];
    for (const [key, state] of counts) {
      if (Number.isInteger(state)) {
        values.push({ key, state });
      }
    }
    if (view.version) {
      values.push({ key: KEYS.VERSION, text: view.version });
    }
  }
  return values.map(({ key, ...value }) => ({
    device_feature_external_id: ids.feature(key),
    ...value,
  }));
}
