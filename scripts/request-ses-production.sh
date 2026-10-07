#!/usr/bin/env bash
# Chiede l'accesso di produzione SES in eu-central-1 (aws sesv2 put-account-details).
# Se le credenziali mancano, stampa il comando e il testo ed esce 2. Non riprova.
# Non stampa chiavi né l'output di sts get-caller-identity (contiene l'account id).
set -euo pipefail

export AWS_PAGER=""

if [[ "${AWS_REGION:-}" != "eu-central-1" ]]; then
  echo "AWS_REGION deve essere eu-central-1 (ora: '${AWS_REGION:-non impostata}')." >&2
  echo "Esempio: AWS_REGION=eu-central-1 $0" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/docs/ses-produzione-esito.json"
WEBSITE_URL="${SES_WEBSITE_URL:-https://photos.example}"

load_use_case() {
  cat <<'EOF'
Frames of Me, primo evento di una conferenza europea. Inviamo solo email transazionali.

1) Link di accesso (magic link) a chi chiede di entrare: oggetto «Accedi a Frames of Me», corpo solo l'URL di verifica, scadenza 30 minuti, un solo uso.
2) Avviso di galleria a chi ha dato consenso esplicito al confronto del volto e ha completato la ricerca: oggetto «Le tue foto sono pronte», corpo solo il link alla galleria personale. Nessun allegato, nessuna immagine, nessuna newsletter.

Non è marketing. Non usiamo liste acquistate. Il destinatario è la persona che ha chiesto il link o che ha acconsentito. Volume atteso per il primo evento: sotto i 10.000 messaggi (circa 6.000 interessati). Mittente: dominio verificato in eu-central-1 con DKIM. Bounce e complaint vanno nella suppression list dell'account: chi rimbalza o reclama non riceve altri invii.

Frames of Me, first event of a European conference. We send only transactional email.

1) An access link (magic link) to someone who asks to sign in: subject "Accedi a Frames of Me", body only the verification URL, 30-minute expiry, single use.
2) A gallery notice to someone who gave explicit consent to face matching and whose search finished: subject "Le tue foto sono pronte", body only the link to their personal gallery. No attachments, no images, no newsletter.

This is not marketing. We do not use purchased lists. The recipient is the person who requested the link or who consented. Expected volume for the first event: under 10,000 messages (about 6,000 data subjects). Sender: a domain verified in eu-central-1 with DKIM. Bounces and complaints go on the account suppression list: a recipient who bounces or complains gets no further mail.
EOF
}
USE_CASE=$(load_use_case)

if ((${#USE_CASE} > 5000)); then
  echo "use-case-description supera il massimo di 5000 caratteri (${#USE_CASE})." >&2
  exit 2
fi

scrub() {
  sed -E \
    -e 's/AKIA[0-9A-Z]{16}/[redacted-access-key]/g' \
    -e 's/ASIA[0-9A-Z]{16}/[redacted-access-key]/g' \
    -e 's/(SecretAccessKey|aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[=:][^[:space:]]+/\1=[redacted]/g'
}

print_next() {
  cat <<EOF
Comando successivo, dopo aver configurato credenziali per eu-central-1. Non è stato eseguito.

AWS_REGION=eu-central-1 aws sesv2 put-account-details \\
  --region eu-central-1 \\
  --mail-type TRANSACTIONAL \\
  --website-url "${WEBSITE_URL}" \\
  --contact-language EN \\
  --production-access-enabled \\
  --use-case-description "\$(cat <<'USECASE'
${USE_CASE}
USECASE
)"

Testo della richiesta:

${USE_CASE}
EOF
}

sts_err=$(mktemp)
put_err=$(mktemp)
put_out=$(mktemp)
status_out=$(mktemp)
cleanup() { rm -f "$sts_err" "$put_err" "$put_out" "$status_out"; }
trap cleanup EXIT

if ! aws sts get-caller-identity --region "$AWS_REGION" --output text >/dev/null 2>"$sts_err"; then
  echo "Credenziali AWS non disponibili. Production access NON richiesto." >&2
  echo "Errore di aws sts get-caller-identity:" >&2
  scrub <"$sts_err" >&2
  echo >&2
  print_next >&2
  exit 2
fi

write_failure() {
  local message="$1"
  MESSAGE="$message" OUT_PATH="$OUT" python3 - <<'PY'
import json, os, re
text = os.environ["MESSAGE"]
text = re.sub(r"AKIA[0-9A-Z]{16}", "[redacted-access-key]", text)
text = re.sub(r"ASIA[0-9A-Z]{16}", "[redacted-access-key]", text)
json.dump(
    {
        "date": "2026-10-06",
        "region": "eu-central-1",
        "api": "sesv2 put-account-details",
        "submitted": False,
        "error": text,
    },
    open(os.environ["OUT_PATH"], "w"),
    indent=2,
    ensure_ascii=False,
)
open(os.environ["OUT_PATH"], "a").write("\n")
PY
}

if ! aws sesv2 put-account-details \
  --region "$AWS_REGION" \
  --mail-type TRANSACTIONAL \
  --website-url "$WEBSITE_URL" \
  --contact-language EN \
  --production-access-enabled \
  --use-case-description "$USE_CASE" \
  --output json >"$put_out" 2>"$put_err"; then
  err_text="$(scrub <"$put_err")"
  write_failure "$err_text"
  echo "sesv2 put-account-details non è riuscita. Esito in $OUT" >&2
  printf '%s\n' "$err_text" >&2
  exit 1
fi

if ! aws sesv2 get-account \
  --region "$AWS_REGION" \
  --output json \
  --query '{ProductionAccessEnabled:ProductionAccessEnabled,SendingEnabled:SendingEnabled,EnforcementStatus:EnforcementStatus,SendQuota:SendQuota,MailType:Details.MailType,ReviewStatus:Details.ReviewDetails.Status,CaseId:Details.ReviewDetails.CaseId}' \
  >"$status_out" 2>"$put_err"; then
  err_text="$(scrub <"$put_err")"
  MESSAGE="$err_text" OUT_PATH="$OUT" python3 - <<'PY'
import json, os
json.dump(
    {
        "date": "2026-10-06",
        "region": "eu-central-1",
        "api": "sesv2 put-account-details",
        "submitted": True,
        "getAccountError": os.environ["MESSAGE"],
        "note": "put-account-details è uscito 0; get-account no. Lo stato di revisione non è stato letto.",
    },
    open(os.environ["OUT_PATH"], "w"),
    indent=2,
    ensure_ascii=False,
)
open(os.environ["OUT_PATH"], "a").write("\n")
PY
  echo "put-account-details è uscito 0, get-account no. Esito parziale in $OUT" >&2
  printf '%s\n' "$err_text" >&2
  exit 1
fi

OUT_PATH="$OUT" STATUS_PATH="$status_out" WEBSITE="$WEBSITE_URL" python3 - <<'PY'
import json, os
status = json.load(open(os.environ["STATUS_PATH"]))
quota = status.get("SendQuota") or {}
allowed_quota = {
    "Max24HourSend": quota.get("Max24HourSend"),
    "MaxSendRate": quota.get("MaxSendRate"),
    "SentLast24Hours": quota.get("SentLast24Hours"),
}
doc = {
    "date": "2026-10-06",
    "region": "eu-central-1",
    "api": "sesv2 put-account-details",
    "mailType": "TRANSACTIONAL",
    "websiteUrl": os.environ["WEBSITE"],
    "submitted": True,
    "putAccountDetailsOutput": "None (come documentato da aws sesv2 put-account-details help)",
    "productionAccessEnabled": status.get("ProductionAccessEnabled"),
    "sendingEnabled": status.get("SendingEnabled"),
    "enforcementStatus": status.get("EnforcementStatus"),
    "sendQuota": allowed_quota,
    "reviewStatus": status.get("ReviewStatus"),
    "reviewCaseId": status.get("CaseId"),
}
json.dump(doc, open(os.environ["OUT_PATH"], "w"), indent=2, ensure_ascii=False)
open(os.environ["OUT_PATH"], "a").write("\n")
PY

echo "Richiesta inviata. Stato filtrato in $OUT" >&2
