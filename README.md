# Keycloak for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that brings [Keycloak](https://www.keycloak.org/), the open-source identity
and access management server (SSO, MFA), into Gladys: who failed to log in,
which account got locked, who granted an admin role, and a notification the
moment it happens.

- **A device per realm**: reachable, failed logins over 1 hour and 24 hours,
  successful logins over 24 hours, users, active sessions, locked accounts,
  version.
- **Scene triggers**: a failed login (user, address, application), a series of
  failed logins (N in M minutes, set in the configuration), an account locked
  by the brute-force protection, a sensitive admin event (admin role granted,
  user created or deleted, client or realm changed).
- **Scene action**: Keycloak state in a ready-made sentence.
- **Dashboard widget**: the counts of the day, the locked accounts and the
  latest events.
- Read-only: nothing in Keycloak can be changed from Gladys.
- Several realms with one client of the master realm.
- Texts in English, French, German and Spanish.

Tested against a real Keycloak 26.4.7 (official image
`quay.io/keycloak/keycloak`, `start-dev`, a test realm with the events and the
brute-force detection on, a read-only service account, failed and successful
logins played through the OpenID Connect API). Developed without a production
installation: feedback welcome on
[the issues](https://github.com/guim31/gladys-keycloak/issues).

## Requirements

- Gladys Assistant 5.1.0 or later.
- Keycloak reachable from the Gladys machine (tested with 26.4).
- The user events and the admin events saved in each realm watched ("Include
  representation" on for the names of the roles and users).
- A confidential client with a service account holding `view-events`,
  `view-users` and `view-realm` of `realm-management` (or of `<realm>-realm`
  for a client of master).

## Installation

In Gladys, open **Integrations → Install from GitHub** and enter
`https://github.com/guim31/gladys-keycloak`. Then open its configuration,
enter the address of Keycloak, the realms, the client ID and secret, and add
the devices from the Discover tab.

The full guide: [docs/en.md](docs/en.md) (also in [French](docs/fr.md),
[German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

The container gets an access token by the `client_credentials` grant, renewed
before it expires. Every minute by default, for each realm, it reads the user
events (`LOGIN`, `LOGIN_ERROR` and the lockouts) and the admin events (users,
role mappings, clients, realm) since the latest one already seen
(`dateFrom`), the active sessions, the brute-force status of the accounts
found locked, the number of users (every 10 minutes) and the version (every
hour, `/admin/serverinfo`). The time of the latest event seen and the locked
accounts are kept in `/data`, so an event during a restart is announced once.
User names and addresses never go to the info logs.

## Limits

- One Keycloak server per integration, 10 realms at most.
- 1,000 events per realm at most per read (3,000 at start): beyond, the counts
  are lower bounds.
- At most 10 scene events per trigger and per read.
- The version is only readable with a client of the master realm.
- A self-signed HTTPS certificate is not accepted (use the `http://` local
  address).

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and the notes on the Keycloak
API. The architecture follows
[gladys-authentik](https://github.com/guim31/gladys-authentik), its neighbour.

## Credits

- [Keycloak](https://github.com/keycloak/keycloak), a Cloud Native Computing
  Foundation project (Apache-2.0): the answers in `test/fixtures/keycloak` come
  from its official image (`quay.io/keycloak/keycloak:26.4`), addresses
  anonymised.
- The Keycloak logo on the cover is the official one
  (`logo/logo-stacked-white.svg` of the
  [keycloak-misc](https://github.com/keycloak/keycloak-misc) repository,
  Apache-2.0 according to
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Keycloak_Logo.png)),
  on the blue of the brand; it belongs to the Keycloak project.

Not affiliated with the Keycloak project, the Cloud Native Computing
Foundation or Red Hat.

## License

Apache-2.0, see [LICENSE](LICENSE).
