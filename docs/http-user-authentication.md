# HTTP User Authentication

Human-facing HTTP APIs require a verified Supabase access token. The access token identifies the individual caller; when configured, the shared Admin API key remains a temporary additional boundary and never supplies actor identity.

## Request contract

```http
Authorization: Bearer <Supabase access token>
X-Admin-Api-Key: <transitional shared boundary>
```

The backend calls Supabase Auth `getUser` for every supplied access token. It reads `app_metadata.gwens_user_id`, which must be a positive ID of a normalized Gwens `users` row. User-controlled `user_metadata` is never accepted for this mapping.

After verification, the backend reloads the normalized user and current role permissions. Inactive, incomplete, missing, expired, revoked, or unmapped identities are denied. OWNER routes additionally require the caller's own role to be `OWNER`. Governance routes additionally require an active `SYSTEM_ADMIN` assignment and their established Divisi checks.

Machine endpoints keep their dedicated integration authentication and do not use human sessions.

## Provisioning

1. Create or identify the person's Supabase Auth account through approved administrator tooling.
2. Confirm the corresponding normalized Gwens user is active and has the intended Divisi and role.
3. Set the Auth account's server-controlled `app_metadata.gwens_user_id` to that normalized numeric user ID.
4. Have the user obtain a normal Supabase session and send its access token as a Bearer token.
5. Exercise one read-only endpoint and confirm the returned scope matches that user's permissions before enabling mutations.

Never place the mapping in `user_metadata`, query parameters, logs, screenshots, or repository files. Removing the app-metadata mapping or disabling the normalized user revokes HTTP access without changing other users' credentials.

## Migration and rollback

Migrate operators one at a time while retaining the configured Admin API key as a second boundary. Confirm audit records contain the authenticated user's normalized ID. Once every human client uses sessions, retire any client behavior that assumes the shared key represents a person.

Rollback consists of reverting this application release. No database migration is required. Keep the previous release available until all required users have verified mappings and sessions.
