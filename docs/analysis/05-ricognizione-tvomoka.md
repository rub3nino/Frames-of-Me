# Ricognizione tvoMoka (BE + SETUP) per il gestionale admin

Data: 2026-10-08. Repo esaminate: `SebastianI5/tvoMokaBE`, `SebastianI5/tvoMokaSETUP`
(clonate in locale per l'analisi; esiste anche `tvoMokaFE`, porta 4200, non clonata).

## Verdetto in una riga

**tvoMoka non è un gestionale eventi** (niente eventi, sponsor, biglietti, sessioni): è un
boilerplate di CRM multi-tenant NestJS. Dal dominio non si riprende nulla; si riprendono i
**pattern** di auth, RBAC, audit, paginazione e menu dinamico.

## Stack

NestJS 11 + TypeORM + PostgreSQL 16 con Row-Level Security; BullMQ/Redis per job (purge account,
pulizia token); nodemailer/SMTP (Mailpit in locale); Swagger su `/docs`; pino, helmet, throttler su
Redis; validazione class-validator + zod. SETUP = docker-compose (Postgres, Redis, Mailpit),
Makefile, `initdb/01-roles.sh` (ruolo `*_app` senza BYPASSRLS).

## Entità

`Company` (tenant: ACTIVE/SUSPENDED/PENDING_DELETION) · `User` (argon2, emailVerified, lock dopo
tentativi falliti, soft-delete con purge_at) · RBAC: `Role`, `Permission`, `UserRole`,
`RolePermission`; ruoli seed OWNER/ADMIN/MEMBER/VIEWER (+ ROOT piattaforma) · `MenuItem` (menu
dinamico i18n) · `AuditLog` · `AuthToken`/`RefreshToken`.

## Endpoint (per area)

- **auth**: register, verify-email, resend-verification, login, refresh, logout,
  forgot/reset/change-password, delete-account (con conferma e annullo), `GET me`.
- **users**: lista paginata, CRUD, `me`, activate, status, ruoli.
- **rbac**: roles/permissions CRUD + matrice ruolo↔permessi.
- **menus**: `GET me` (filtrato per permessi), CRUD.
- **settings**, **audit** (`GET`, `GET actions`), **platform** (solo ROOT), **health**.

## Autenticazione

JWT di accesso ~15 min (payload solo `sub`) + refresh opaco ~30 gg ruotato con rilevamento riuso;
entrambi cookie httpOnly SameSite=lax; CSRF via Origin; FE con `withCredentials: true`.
Permessi: `@RequirePermissions` + PermissionsGuard, CASL PoliciesGuard; catalogo in
`src/rbac/permissions.catalog.ts` (es. `users:read|write`, `roles:manage`, `audit:read`).
**Niente Google OAuth** (escluso dall'ADR 0001 per la v1).

## Cosa riusiamo in Frames of Me

| Pattern tvoMoka | Applicazione FOM |
|---|---|
| RBAC ruoli↔permessi con matrice da UI | i 4 tier admin di `02-admin-spec.md:54-93` (Super-admin, Editor, Moderatore, Sola lettura) ≈ OWNER/ADMIN/MEMBER/VIEWER |
| Menu dinamico `/menus/me` filtrato per permesso | sidebar admin che mostra solo le sezioni consentite |
| Audit log con catalogo azioni | requisito GDPR/audit già previsto nello spec admin |
| Paginazione `{data, meta}` con page/limit/sort/search (ADR 0003) | liste foto/gallerie/partecipanti |
| Stati utente + lock tentativi | account staff e fotografi |
| Flussi reset password / verifica email | account con password (v6) |
| Cookie httpOnly + rotazione refresh | già coerente con la sessione opaca `rephoto_session` attuale |

## Delta con l'API FOM attuale

L'API FOM (Hono, `apps/api/src/routes.ts`) usa sessione opaca su cookie, magic link e password solo
staff; mancano (previsti v6): Google OIDC, `POST /v1/auth/register`, liste fotografi/partecipanti,
lettura audit, GDPR self-service. Gli endpoint fotografo G1-G15 sono elencati in
`docs/analysis/03-photographer-spec.md:300-318`, quelli admin proposti in
`docs/analysis/02-admin-spec.md:491-590`.
