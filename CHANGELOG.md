# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-21

### Added

- One "Keycloak <realm>" device per realm watched (up to 10): reachable, failed
  logins over 1 hour and 24 hours, successful logins over 24 hours, users,
  active sessions, accounts locked by the brute-force protection, version of
  Keycloak.
- Scene triggers: a failed login (realm, user, address, application, error
  code), a series of failed logins (number and window set in the
  configuration), an account locked by the brute-force protection, a sensitive
  admin event (admin role or other role granted, user created or deleted,
  client created, changed or deleted, realm settings changed).
- Scene action "Keycloak state": the counts and a ready-made sentence.
- Dashboard widget "Keycloak security": the counts of the day, the locked
  accounts and the latest events.
- "Test the connection" action. A service account with read roles only,
  token renewed before it expires; nothing announced twice across restarts.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-keycloak/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-keycloak/releases/tag/v1.0.0
