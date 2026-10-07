# Accesso di produzione Amazon SES (`eu-central-1`)

Data: 2026-10-06. CLI su questa macchina: **aws-cli/2.37.0**. I nomi dei comandi sono quelli di `aws sesv2 help` di quella versione. L'esito in fondo è quello dell'esecuzione unica di `scripts/request-ses-production.sh`, non una supposizione.

Dominio segnaposto, da sostituire con il dominio di **[organizzatore della conferenza]** prima del DNS reale: `photos.example`. Non è un dominio registrato. Sito segnaposto richiesto dall'API (`--website-url` è obbligatorio): `https://photos.example`. Si sovrascrive con la variabile `SES_WEBSITE_URL`.

## 1. Verificare l'identità di dominio (DKIM)

Regione sempre `eu-central-1`. Easy DKIM con chiave RSA 2048, parametro documentato in `aws sesv2 create-email-identity help` (`NextSigningKeyLength`: `RSA_1024_BIT` oppure `RSA_2048_BIT`):

```bash
aws sesv2 create-email-identity \
  --region eu-central-1 \
  --email-identity photos.example \
  --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT
```

Poi si leggono i token. Da `aws sesv2 get-email-identity help`, la struttura `DkimAttributes` ha `SigningEnabled`, `Status` (`PENDING`, `SUCCESS`, `FAILED`, `TEMPORARY_FAILURE`, `NOT_STARTED`), `Tokens` e `SigningHostedZone`. L'help descrive i CNAME così: per ogni selettore, `selector._domainkey.dominio` CNAME `selector.<SigningHostedZone>`. I token veri li restituisce l'API; non si inventano.

```bash
aws sesv2 get-email-identity \
  --region eu-central-1 \
  --email-identity photos.example \
  --query 'DkimAttributes.{Status:Status,SigningEnabled:SigningEnabled,Tokens:Tokens,SigningHostedZone:SigningHostedZone,SigningAttributesOrigin:SigningAttributesOrigin}'
```

Per ogni token `T` in `Tokens`:

```text
T._domainkey.photos.example.   CNAME   T.<SigningHostedZone>
```

SES cerca i record fino a 72 ore (`get-email-identity help`). Se `SigningEnabled` è falso:

```bash
aws sesv2 put-email-identity-dkim-attributes \
  --region eu-central-1 \
  --email-identity photos.example \
  --signing-enabled
```

`VerifiedForSendingStatus` si controlla sulla stessa `get-email-identity`. Finché il dominio non è verificato non si spedisce da quell'identità.

Mittente previsto, ancora segnaposto: un indirizzo su quel dominio (per esempio `no-reply@photos.example`). Il contratto non fissa l'indirizzo From: fissa i testi. Oggetto del magic link: `Accedi a Frames of Me`. Oggetto galleria: `Le tue foto sono pronte`. Corpo: solo l'URL, niente allegati.

## 2. L'account resta in sandbox finché l'accesso di produzione non è concesso

`aws sesv2 put-account-details help` dice, alla lettera sul flag booleano:

> If the value is false, then your account is in the sandbox. When your account is in the sandbox, you can only send email to verified identities.
>
> If the value is true, then your account has production access.

Lo stato si legge con `get-account`, non si deduce dall'aver lanciato il comando. `Details.ReviewDetails.Status`, dallo stesso help di `get-account`:

| Status | Significato nell'help |
| --- | --- |
| `PENDING` | La richiesta è in revisione |
| `GRANTED` | Accesso di produzione concesso |
| `DENIED` | Accesso negato |
| `FAILED` | Errore interno, la richiesta non è arrivata e si può rimandare |

`CaseId` è l'id del caso nel support center, se c'è. L'help chiama questa revisione «appeal».

Controllo, senza scaricare l'account intero:

```bash
aws sesv2 get-account --region eu-central-1 \
  --query '{ProductionAccessEnabled:ProductionAccessEnabled,SendingEnabled:SendingEnabled,EnforcementStatus:EnforcementStatus,ReviewStatus:Details.ReviewDetails.Status,CaseId:Details.ReviewDetails.CaseId}'
```

`ProductionAccessEnabled: false` significa sandbox: si scrive solo a identità già verificate. Mailpit in locale (`MAIL_TRANSPORT=smtp`, UI `http://localhost:8025`) non passa da SES.

## 3. Testo della richiesta

`put-account-details` vuole `--mail-type` (`TRANSACTIONAL` o `MARKETING`) e `--website-url`. Qui il tipo è `TRANSACTIONAL`. `--contact-language` accetta solo `EN` o `JA`; si passa `EN`. Il testo d'uso è in italiano e in inglese (limite help: 5000 caratteri).

```text
Frames of Me, primo evento di una conferenza europea. Inviamo solo email transazionali.

1) Link di accesso (magic link) a chi chiede di entrare: oggetto «Accedi a Frames of Me», corpo solo l'URL di verifica, scadenza 30 minuti, un solo uso.
2) Avviso di galleria a chi ha dato consenso esplicito al confronto del volto e ha completato la ricerca: oggetto «Le tue foto sono pronte», corpo solo il link alla galleria personale. Nessun allegato, nessuna immagine, nessuna newsletter.

Non è marketing. Non usiamo liste acquistate. Il destinatario è la persona che ha chiesto il link o che ha acconsentito. Volume atteso per il primo evento: sotto i 10.000 messaggi (circa 6.000 interessati). Mittente: dominio verificato in eu-central-1 con DKIM. Bounce e complaint vanno nella suppression list dell'account: chi rimbalza o reclama non riceve altri invii.

Frames of Me, first event of a European conference. We send only transactional email.

1) An access link (magic link) to someone who asks to sign in: subject "Accedi a Frames of Me", body only the verification URL, 30-minute expiry, single use.
2) A gallery notice to someone who gave explicit consent to face matching and whose search finished: subject "Le tue foto sono pronte", body only the link to their personal gallery. No attachments, no images, no newsletter.

This is not marketing. We do not use purchased lists. The recipient is the person who requested the link or who consented. Expected volume for the first event: under 10,000 messages (about 6,000 data subjects). Sender: a domain verified in eu-central-1 with DKIM. Bounces and complaints go on the account suppression list: a recipient who bounces or complains gets no further mail.
```

Comando, lo stesso che lo script esegue se `aws sts get-caller-identity` riesce. Sostituire l'URL se il sito esiste già:

```bash
AWS_REGION=eu-central-1 aws sesv2 put-account-details \
  --region eu-central-1 \
  --mail-type TRANSACTIONAL \
  --website-url "https://photos.example" \
  --contact-language EN \
  --production-access-enabled \
  --use-case-description "$(cat <<'EOF'
Frames of Me, primo evento di una conferenza europea. Inviamo solo email transazionali.

1) Link di accesso (magic link) a chi chiede di entrare: oggetto «Accedi a Frames of Me», corpo solo l'URL di verifica, scadenza 30 minuti, un solo uso.
2) Avviso di galleria a chi ha dato consenso esplicito al confronto del volto e ha completato la ricerca: oggetto «Le tue foto sono pronte», corpo solo il link alla galleria personale. Nessun allegato, nessuna immagine, nessuna newsletter.

Non è marketing. Non usiamo liste acquistate. Il destinatario è la persona che ha chiesto il link o che ha acconsentito. Volume atteso per il primo evento: sotto i 10.000 messaggi (circa 6.000 interessati). Mittente: dominio verificato in eu-central-1 con DKIM. Bounce e complaint vanno nella suppression list dell'account: chi rimbalza o reclama non riceve altri invii.

Frames of Me, first event of a European conference. We send only transactional email.

1) An access link (magic link) to someone who asks to sign in: subject "Accedi a Frames of Me", body only the verification URL, 30-minute expiry, single use.
2) A gallery notice to someone who gave explicit consent to face matching and whose search finished: subject "Le tue foto sono pronte", body only the link to their personal gallery. No attachments, no images, no newsletter.

This is not marketing. We do not use purchased lists. The recipient is the person who requested the link or who consented. Expected volume for the first event: under 10,000 messages (about 6,000 data subjects). Sender: a domain verified in eu-central-1 with DKIM. Bounces and complaints go on the account suppression list: a recipient who bounces or complains gets no further mail.
EOF
)"
```

L'help di `put-account-details` indica output **None**. L'esito della revisione si rilegge con `get-account` (`ReviewDetails.Status`). Chiamare il comando non significa che `ProductionAccessEnabled` diventi subito `true`.

Lo script `scripts/request-ses-production.sh` richiede `AWS_REGION=eu-central-1`. Se `sts get-caller-identity` fallisce, stampa l'errore, stampa il comando sopra e il testo, ed esce **2**. Non riprova e non chiama `put-account-details`.

## 4. MAIL FROM, bounce e complaint

Nota operativa. Non è una build SNS.

Dominio MAIL FROM, sottodominio dell'identità: `bounce.photos.example`. Comando reale (`aws sesv2 put-email-identity-mail-from-attributes help`):

```bash
aws sesv2 put-email-identity-mail-from-attributes \
  --region eu-central-1 \
  --email-identity photos.example \
  --mail-from-domain bounce.photos.example \
  --behavior-on-mx-failure USE_DEFAULT_VALUE
```

`USE_DEFAULT_VALUE` e `REJECT_MESSAGE` sono i due valori dell'help. Con `USE_DEFAULT_VALUE`, se il MX manca SES spedisce usando `amazonses.com`. Quando il MX è stabile si può passare a `REJECT_MESSAGE`, così un MAIL FROM non verificato non parte. Lo stato è `MailFromAttributes.MailFromDomainStatus`: `PENDING`, `SUCCESS`, `FAILED`, `TEMPORARY_FAILURE`.

Record DNS, dalla guida SES «Using a custom MAIL FROM domain» (pagina `mail-from.html` letta il 2026-10-06; l'help della CLI non stampa l'hostname):

| Nome | Tipo | Valore |
| --- | --- | --- |
| `bounce.photos.example` | MX | `10 feedback-smtp.eu-central-1.amazonses.com` |
| `bounce.photos.example` | TXT | `"v=spf1 include:amazonses.com ~all"` |

La guida scrive `feedback-smtp.` + region + `.amazonses.com` e lo SPF sopra. Qui la region è `eu-central-1`.

Bounce e complaint, senza costruire il topic:

- A livello account, `get-account` espone `SuppressionAttributes`. La suppression list è il minimo: un bounce o un complaint non va rispedito.
- L'applicazione, nel contratto, non ha un job che consuma eventi SES. Per averli in seguito esiste `aws sesv2 create-configuration-set-event-destination`: `MatchingEventTypes` include `BOUNCE` e `COMPLAINT`, destinazione `SnsDestination` oppure `EventBridgeDestination`. Questa nota non crea il topic, il bus né la configuration set.
- Un reclamo è anche un segnale privacy (la persona non vuole quella posta). Il trattamento applicativo di quel segnale non è nel contratto congelato: va aggiunto prima di spedire sul serio a 6.000 indirizzi.

## 5. Esito del 2026-10-06

`scripts/request-ses-production.sh` è stato eseguito con `AWS_REGION=eu-central-1`. **La richiesta non è stata inviata.** `put-account-details` non è stato chiamato. Non esiste `docs/ses-produzione-esito.json`.

Exit code: **2**.

Errore di `aws sts get-caller-identity`, riga intera:

```text
aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials. You can configure credentials by running "aws login".
```

Lo script ha stampato il comando `put-account-details` e il testo della richiesta, poi si è fermato. Non ha ritentato. Per inviarla davvero servono credenziali AWS e un secondo lancio dello stesso script (oppure il comando del §3), dopo aver sostituito `https://photos.example` con il sito dell'evento se esiste già.
