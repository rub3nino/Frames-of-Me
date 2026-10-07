# Frames of Me web

Interfaccia italiana per partecipanti, fotografi e amministrazione. Mobile first.

Il browser chiama solo `/v1` (stesso origine, `credentials: "include"`).
Il server inoltra a `API_PROXY_TARGET`, altrimenti `NEXT_PUBLIC_API_URL`, altrimenti `http://localhost:8787`.
Il cookie di sessione resta first-party. L'origine deve coincidere con `WEB_ORIGIN` (`http://localhost:3000`).

`NEXT_PUBLIC_EVENT_SLUG` (default `demo`) vale per selfie, galleria e upload.
Accesso: `/verify?token=`. Galleria delle mail: `/e/<slug>`.

Sviluppo: `npm install` dalla radice, poi `npm run dev -w @rephoto/web`.
Web su http://localhost:3000, API su http://localhost:8787.
