# Signalman compatibility feedback Relay

This source is intentionally not deployed by the desktop application. It accepts
only the strictly whitelisted `signalman-compatibility-feedback/v1` payload and
creates an Issue in a private feedback inbox with a GitHub App installation
token. The desktop client never receives any GitHub credential.

## Before deployment

The maintainer must explicitly choose and provision all of the following:

1. A Cloudflare Worker name and public HTTPS relay URL.
2. Exact permitted app origins in `ALLOWED_ORIGINS`; do not use `*`.
3. A Turnstile widget and server-side secret. The client must add the issued
   token as `X-Turnstile-Token`; do not enable `TURNSTILE_SECRET` until the
   client-side widget has been configured for the deployed origin.
4. A GitHub App installed only on a private feedback-inbox repository, with the
   minimum Issues write permission.
5. `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, and
   `GITHUB_FEEDBACK_REPOSITORY` as encrypted Worker secrets.
6. A data-retention policy, deletion path, privacy notice, and a maintainer
   contact route.

Do not use a personal access token. Do not put any of these values in Git,
the desktop application's environment, screenshots, logs, or release assets.

## Local contract checks

Run `node --test feedback-relay/test/schema.test.mjs`. This validates schema
whitelisting and secret/path rejection without contacting Cloudflare or GitHub.

## Deployment gate

Before a production deployment, re-check current Cloudflare Turnstile
Siteverify and Worker-secret documentation, add a Worker integration test for
the configured origin and Turnstile widget, and send one controlled test to the
private inbox. A successful desktop-side HTTP request is not enough evidence
that an Issue was received.
