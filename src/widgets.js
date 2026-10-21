// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `security_events`.
//
// The use case: a glance at the wall tablet tells whether someone is trying
// passwords on the home single sign-on, whether an account got locked, and
// what changed in the administration lately. So the widget shows the failed
// and successful logins of the last 24 hours and the locked accounts, then
// the latest events — user, what happened, realm and time — latest first.
//
// The figures are sent as values, not bound to device features: the widget
// works before the devices are added.
//
// Budget (8 components, 2 texts): three tiles, one text when Keycloak does
// not answer or nothing happened, one status list, a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from './hub.js';
import { CONNECTION_TEXT, ERROR_TEXT, labelled, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 8;

export const TEXT = {
  empty: {
    en: 'No login or admin event in the last 24 hours.',
    fr: "Aucune connexion ni action d'administration ces dernières 24 heures.",
    de: 'Keine Anmeldung und keine Verwaltungsaktion in den letzten 24 Stunden.',
    es: 'Ningún inicio de sesión ni acción de administración en las últimas 24 horas.',
  },
  failed: { en: 'Failures 24 h', fr: 'Échecs 24 h', de: 'Fehlversuche 24 h', es: 'Fallos 24 h' },
  logins: { en: 'Logins 24 h', fr: 'Connexions 24 h', de: 'Anmeldungen 24 h', es: 'Accesos 24 h' },
  locked: { en: 'Locked', fr: 'Bloqués', de: 'Gesperrt', es: 'Bloqueadas' },
  unknown: { en: 'unknown user', fr: 'inconnu', de: 'unbekannt', es: 'desconocido' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Keycloak read again.',
    fr: 'Keycloak relu.',
    de: 'Keycloak neu gelesen.',
    es: 'Keycloak leído de nuevo.',
  },
};

// What happened, in a few words (the value of a row): user events by type,
// admin events by kind.
export const EVENT_LABELS = {
  LOGIN: { en: 'login', fr: 'connexion', de: 'Anmeldung', es: 'acceso' },
  LOGIN_ERROR: { en: 'failed login', fr: 'échec', de: 'Fehlversuch', es: 'fallo' },
  USER_DISABLED_BY_TEMPORARY_LOCKOUT: {
    en: 'locked',
    fr: 'bloqué',
    de: 'gesperrt',
    es: 'bloqueada',
  },
  USER_DISABLED_BY_PERMANENT_LOCKOUT: {
    en: 'locked for good',
    fr: 'bloqué définitivement',
    de: 'dauerhaft gesperrt',
    es: 'bloqueada del todo',
  },
  admin_role_granted: { en: 'admin role', fr: 'rôle admin', de: 'Adminrolle', es: 'rol admin' },
  role_granted: {
    en: 'role granted',
    fr: 'rôle attribué',
    de: 'Rolle erteilt',
    es: 'rol asignado',
  },
  user_created: {
    en: 'user created',
    fr: 'utilisateur créé',
    de: 'Benutzer angelegt',
    es: 'usuario creado',
  },
  user_deleted: {
    en: 'user deleted',
    fr: 'utilisateur supprimé',
    de: 'Benutzer gelöscht',
    es: 'usuario eliminado',
  },
  client_changed: {
    en: 'client changed',
    fr: 'client modifié',
    de: 'Client geändert',
    es: 'cliente modificado',
  },
  realm_changed: {
    en: 'realm changed',
    fr: 'realm modifié',
    de: 'Realm geändert',
    es: 'realm modificado',
  },
};

// Who an admin event is about when Keycloak gives no name (no
// "Include representation").
export const ADMIN_LABEL = {
  en: 'administration',
  fr: 'administration',
  de: 'Verwaltung',
  es: 'administración',
};

const ROW_STYLE = {
  LOGIN: { icon: 'log-in', color: WIDGET_COLORS.SUCCESS },
  LOGIN_ERROR: { icon: 'x-circle', color: WIDGET_COLORS.DANGER },
  USER_DISABLED_BY_TEMPORARY_LOCKOUT: { icon: 'lock', color: WIDGET_COLORS.DANGER },
  USER_DISABLED_BY_PERMANENT_LOCKOUT: { icon: 'lock', color: WIDGET_COLORS.DANGER },
};
const ADMIN_STYLE = { icon: 'alert-triangle', color: WIDGET_COLORS.WARNING };

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** "14:05" in the time zone of Gladys (TZ, set by the supervisor). */
export function formatTime(ms, now) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return now - ms >= 20 * 3600_000
    ? `${date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })} ${time}`
    : time;
}

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: pick(text, language) }],
  };
}

/** One row of the status list. */
function row(event, { language, now, showRealm }) {
  const admin = event.type === 'ADMIN';
  const what = pick(EVENT_LABELS[admin ? event.kind : event.type] ?? { en: event.type }, language);
  const realm = showRealm ? ` · ${event.realm}` : '';
  const who = admin
    ? event.target || pick(ADMIN_LABEL, language)
    : event.username || pick(TEXT.unknown, language);
  return {
    label: fit(who, 40),
    value: fit(`${what}${realm} · ${formatTime(event.time, now)}`, 40),
    ...(admin ? ADMIN_STYLE : ROW_STYLE[event.type]),
  };
}

async function get(hub, { language = 'en' }) {
  const status = hub.connectionStatus();
  if (!hub.client) {
    return message(status.message ?? CONNECTION_TEXT.noUrl, language);
  }
  const now = hub.now();
  const { failed24h, logins24h, locked } = hub.counts();
  const components = [
    {
      type: 'value',
      value: failed24h,
      label: pick(TEXT.failed, language),
      icon: 'x-circle',
      color: failed24h > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: logins24h,
      label: pick(TEXT.logins, language),
      icon: 'log-in',
      color: WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: locked,
      label: pick(TEXT.locked, language),
      icon: 'lock',
      color: locked > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    },
  ];

  if (hub.error) {
    // One realm (or all) cannot be read.
    const text = pick(ERROR_TEXT[hub.error.kind], language);
    components.push({
      type: 'text',
      variant: 'body',
      text: hub.realms.size > 1 ? labelled(hub.error.realm, text, language) : text,
    });
  }

  const events = hub.latestEvents(MAX_ROWS);
  if (events.length > 0) {
    const showRealm = hub.realms.size > 1;
    components.push({
      type: 'status',
      items: events.map((event) => row(event, { language, now, showRealm })),
    });
  } else if (!hub.error) {
    components.push({ type: 'text', variant: 'body', text: pick(TEXT.empty, language) });
  }

  components.push({
    type: 'button',
    label: pick(TEXT.refresh, language),
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: ACTIONS.REFRESH },
  });

  return { ttl_seconds: hub.error ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  if (!hub.client) {
    return { message: hub.connectionStatus().message ?? CONNECTION_TEXT.noUrl };
  }
  await hub.pollNow();
  if (hub.failing) {
    return { message: ERROR_TEXT[hub.error.kind] };
  }
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
