// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// - get_status: sums up Keycloak for a message (failed and successful logins,
//   locked accounts, users, the latest failure, every realm watched), what a
//   condition on a device cannot put in words. It reads Keycloak again when
//   the last read is older than 15 seconds. Nothing in Keycloak can be changed
//   from Gladys: the roles of the service account only read.
// -----------------------------------------------------------------------------

export const SCENE_ACTIONS = {
  async get_status(hub) {
    if (!hub.client) {
      hub.assertReadable(); // no address, realm or client: the configuration to fix
    }
    await hub.refreshIfStale();
    const language = hub.config.language;
    const sentence = `${hub.summary(language)}.`;
    if (hub.failing || !hub.reachable) {
      // "Keycloak does not answer" is an answer: the scene goes on with it.
      return {
        reachable: false,
        failed_logins_1h: 0,
        failed_logins_24h: 0,
        logins_24h: 0,
        locked_accounts: 0,
        users: 0,
        sessions: 0,
        version: '',
        last_failed_username: '',
        last_failed_ip: '',
        sentence,
      };
    }
    const counts = hub.counts();
    const lastFailed = hub.latestFailure();
    return {
      reachable: true,
      failed_logins_1h: counts.failed1h,
      failed_logins_24h: counts.failed24h,
      logins_24h: counts.logins24h,
      locked_accounts: counts.locked,
      users: counts.users ?? 0,
      sessions: counts.sessions ?? 0,
      version: hub.version ?? '',
      last_failed_username: lastFailed?.username ?? '',
      last_failed_ip: lastFailed?.ip ?? '',
      sentence,
    };
  },
};
