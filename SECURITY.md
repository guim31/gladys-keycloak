# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- the client secret of the Keycloak service account, stored by Gladys in the
  integration configuration, sent only to the token endpoint of the Keycloak
  address configured (in the body of a POST, never in a URL), never logged.
  The access tokens it gets stay in memory. The documentation asks for the
  read roles `view-events`, `view-users` and `view-realm` only: the
  integration never writes to Keycloak;
- `/data/keycloak-state.json`: the address of Keycloak and, per realm, the
  time and ids of the latest events seen and the ids of the accounts found
  locked. No user name, no address;
- user names, addresses, client ids and role names of the events: kept in
  memory for the last 24 hours, passed to the scenes and the widget, logged at
  the debug level only;
- network: outbound HTTP(S) requests to the Keycloak address only.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the third-party services and devices the integration talks to.
