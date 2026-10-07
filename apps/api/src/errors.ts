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
  // v6 (agent B): self-registration and Google login.
  eventCodeInvalid: "Codice evento non valido, scaduto o esaurito.",
  accountExists: "Esiste già un account con questa email. Accedi o reimposta la password.",
  passwordTooShort: "La password deve avere almeno 10 caratteri.",
  googleUnavailable: "Accesso con Google non disponibile.",
  // v6 (agent E): tagging. The three refusals below are deliberately vague about *why*:
  // "non taggabile" and "già taggato o rifiutato" must not become an oracle that tells a
  // stranger whether a given person is at the event or has refused a tag.
  notEventMember: "Non risulti tra i partecipanti di questo evento.",
  tagNotAllowed: "Questa persona non può essere taggata.",
  tagExists: "Il tag non è stato aggiunto.",
  tagNameRequired: "Scegli un nome visibile prima di attivare i tag.",
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
