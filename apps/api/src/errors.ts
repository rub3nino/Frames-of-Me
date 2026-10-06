export const MESSAGES = {
  validation: "Dati non validi.",
  linkInvalid: "Link non valido oppure già usato.",
  unauthorized: "Accesso richiesto.",
  forbidden: "Non hai i permessi per questa operazione.",
  consentRequired: "È necessario il consenso prima di inviare il selfie.",
  notFound: "Risorsa non trovata.",
  conflict: "Operazione in conflitto con lo stato attuale.",
  rateLimited: "Troppe richieste. Riprova più tardi.",
  internal: "Errore interno.",
} as const;

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
