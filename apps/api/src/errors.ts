export const MESSAGES = {
  validation: "Dati non validi.",
  linkInvalid: "Link non valido oppure già usato.",
  loginInvalid: "Email o password non corrette.",
  unauthorized: "Accesso richiesto.",
  forbidden: "Non hai i permessi per questa operazione.",
  notOnList: "La tua email non è nell'elenco dei partecipanti di questo evento.",
  sizeMismatch: "La dimensione del file caricato non corrisponde a quella dichiarata.",
  consentRequired: "È necessario il consenso prima di inviare il selfie.",
  notFound: "Risorsa non trovata.",
  conflict: "Operazione in conflitto con lo stato attuale.",
  rateLimited: "Troppe richieste. Riprova più tardi.",
  selfieNotKept: "Il selfie non è stato conservato: serve KEEP_SELFIES e un nuovo selfie.",
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
