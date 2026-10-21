// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, scene outputs.
// Four languages, the four of the Gladys interface; German says "du", Spanish
// "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './keycloak/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of Keycloak in the configuration.',
    fr: "Saisissez l'adresse de Keycloak dans la configuration.",
    de: 'Gib die Adresse von Keycloak in der Konfiguration ein.',
    es: 'Introduzca la dirección de Keycloak en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. https://sso.example.com',
    fr: 'Adresse incomprise, ex. https://sso.example.com',
    de: 'Adresse nicht verstanden, z. B. https://sso.example.com',
    es: 'Dirección no válida, p. ej. https://sso.example.com',
  },
  noRealm: {
    en: 'Enter the realm(s) to watch in the configuration.',
    fr: 'Saisissez le ou les realms à surveiller dans la configuration.',
    de: 'Gib den oder die zu überwachenden Realms in der Konfiguration ein.',
    es: 'Introduzca el o los realms que vigilar en la configuración.',
  },
  noClient: {
    en: 'Enter the client id and secret of the service account (see the documentation).',
    fr: 'Saisissez l’identifiant et le secret du client du compte de service (voir la documentation).',
    de: 'Gib Client-ID und Geheimnis des Dienstkontos ein (siehe Dokumentation).',
    es: 'Introduzca el id y el secreto del cliente de la cuenta de servicio (consulte la documentación).',
  },
};

// One short explanation per error kind (src/keycloak/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'Keycloak does not answer',
    fr: 'Keycloak ne répond pas',
    de: 'Keycloak antwortet nicht',
    es: 'Keycloak no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'TLS refused: trusted certificate needed, or http:// (port 8080)',
    fr: 'TLS refusé : certificat reconnu nécessaire, ou http:// (port 8080)',
    de: 'TLS abgelehnt: vertrauenswürdiges Zertifikat nötig oder http:// (Port 8080)',
    es: 'TLS rechazado: hace falta un certificado reconocido, o http:// (puerto 8080)',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'client refused: id, secret or service account to check',
    fr: 'client refusé : identifiant, secret ou compte de service à vérifier',
    de: 'Client abgelehnt: ID, Geheimnis oder Dienstkonto prüfen',
    es: 'cliente rechazado: revise el id, el secreto o la cuenta de servicio',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'role missing for the service account: see the documentation',
    fr: 'rôle manquant pour le compte de service : voir la documentation',
    de: 'Dem Dienstkonto fehlt eine Rolle: siehe Dokumentation',
    es: 'falta un rol a la cuenta de servicio: consulte la documentación',
  },
  [ERROR_KINDS.REALM]: {
    en: 'realm not found (name is case-sensitive)',
    fr: 'realm introuvable (attention aux majuscules)',
    de: 'Realm nicht gefunden (Groß- und Kleinschreibung beachten)',
    es: 'realm no encontrado (distingue mayúsculas)',
  },
  [ERROR_KINDS.NOT_KEYCLOAK]: {
    en: 'no Keycloak at this address (old /auth path?)',
    fr: 'pas de Keycloak à cette adresse (ancien chemin /auth ?)',
    de: 'kein Keycloak unter dieser Adresse (alter Pfad /auth?)',
    es: 'no hay Keycloak en esta dirección (¿antigua ruta /auth?)',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// The "Test the connection" report and the sentence of "Keycloak state".
export const REPORT_TEXT = {
  en: {
    ok: (version) => `Connected (${version || 'version hidden outside master'})`,
    failed: (hour, day) => `${hour} failed login(s) in 1 h, ${day} in 24 h`,
    logins: (count) => `${count} login(s) in 24 h`,
    locked: (count) => `${count} locked account(s)`,
    users: (count) => `${count} user(s)`,
    unreachable: 'does not answer',
  },
  fr: {
    ok: (version) => `Connecté (${version || 'version masquée hors master'})`,
    failed: (hour, day) => `${hour} échec(s) de connexion en 1 h, ${day} en 24 h`,
    logins: (count) => `${count} connexion(s) en 24 h`,
    locked: (count) => `${count} compte(s) bloqué(s)`,
    users: (count) => `${count} utilisateur(s)`,
    unreachable: 'ne répond pas',
  },
  de: {
    ok: (version) => `Verbunden (${version || 'Version außerhalb von master verborgen'})`,
    failed: (hour, day) => `${hour} fehlgeschlagene Anmeldung(en) in 1 h, ${day} in 24 h`,
    logins: (count) => `${count} Anmeldung(en) in 24 h`,
    locked: (count) => `gesperrte Konten: ${count}`,
    users: (count) => `${count} Benutzer`,
    unreachable: 'antwortet nicht',
  },
  es: {
    ok: (version) => `Conectado (${version || 'versión oculta fuera de master'})`,
    failed: (hour, day) => `${hour} inicio(s) de sesión fallido(s) en 1 h, ${day} en 24 h`,
    logins: (count) => `${count} inicio(s) de sesión en 24 h`,
    locked: (count) => `${count} cuenta(s) bloqueada(s)`,
    users: (count) => `${count} usuario(s)`,
    unreachable: 'no responde',
  },
};

// Partial failures: the realm answers, one of its endpoints does not.
export const PARTIAL_TEXT = {
  users: {
    en: 'users not readable (role?)',
    fr: 'utilisateurs illisibles (rôle ?)',
    de: 'Benutzer nicht lesbar (Rolle?)',
    es: 'usuarios ilegibles (¿rol?)',
  },
  sessions: {
    en: 'sessions not readable (role?)',
    fr: 'sessions illisibles (rôle ?)',
    de: 'Sitzungen nicht lesbar (Rolle?)',
    es: 'sesiones ilegibles (¿rol?)',
  },
  locks: {
    en: 'lockouts not readable (role?)',
    fr: 'blocages illisibles (rôle ?)',
    de: 'Sperren nicht lesbar (Rolle?)',
    es: 'bloqueos ilegibles (¿rol?)',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
