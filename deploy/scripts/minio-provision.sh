#!/bin/sh
# RePhoto — MinIO provisioning, run once per `docker compose up` by the `minio-init` service.
# Bind-mounted read-only into the container (compose.yml); it runs inside the MinIO image, which
# ships `mc` at /usr/bin/mc.
#
# What it does:
#   1. creates the bucket if it is missing;
#   2. installs the `rephoto-app` policy: read/write/delete of objects in THAT bucket only;
#   3. creates (or re-keys) the application user and attaches the policy.
#
# v6 F2 — least privilege. api and worker used to receive MINIO_ROOT_USER/PASSWORD as
# S3_ACCESS_KEY/S3_SECRET_KEY, so the credentials that sit in two long-running Node processes and
# sign every presigned URL handed to a browser were the MinIO superuser: they could create and
# delete buckets, read the backup copy, add users and change policies. The application user can
# only address objects inside the one bucket. Root stays for this script, the backup sidecar and
# manual administration.
#
# Deliberately NOT granted:
#   s3:ListBucket            — api and worker address every object by key (apps/api/src/objects.ts
#                              uses Get/Put/Delete/Head and the multipart commands, never a
#                              listing), so a leaked application key cannot enumerate the bucket.
#                              Verified against MinIO: a Get/Head of a missing key still answers
#                              NoSuchKey, so `store.get()`/`store.head()` keep returning null
#                              rather than throwing. `mc ls`/`mc stat` DO fail for this user —
#                              they list the prefix first — but the application never lists.
#   any admin:* action       — no user, policy, bucket or service management.
#
# Note: MinIO still lets the application user see this bucket's NAME in a ListBuckets call
# (it filters the list to buckets the user can reach). That leaks nothing: the bucket name is
# already in S3_BUCKET in the same process environment.
#
# Env: MINIO_ROOT_USER MINIO_ROOT_PASSWORD S3_BUCKET S3_APP_ACCESS_KEY S3_APP_SECRET_KEY
#      MINIO_URL (default http://minio:9000)
#
# Idempotent: safe on every `up`. Changing S3_APP_SECRET_KEY in .env.production and recreating
# `minio-init` rotates the application key (then recreate api and worker to pick it up).
set -eu

MC=${MC:-/usr/bin/mc}
MINIO_URL=${MINIO_URL:-http://minio:9000}
BUCKET=${S3_BUCKET:-rephoto}
APP_USER=${S3_APP_ACCESS_KEY:?S3_APP_ACCESS_KEY is required}
APP_SECRET=${S3_APP_SECRET_KEY:?S3_APP_SECRET_KEY is required}
POLICY=${S3_APP_POLICY:-rephoto-app}

log() {
  printf '%s minio-init: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# MinIO rejects a secret key shorter than 8 characters with an opaque error; fail clearly instead.
if [ "${#APP_SECRET}" -lt 8 ]; then
  log "S3_APP_SECRET_KEY must be at least 8 characters (run deploy/scripts/gen-secrets.sh)"
  exit 2
fi
if [ "$APP_USER" = "${MINIO_ROOT_USER:-}" ]; then
  log "S3_APP_ACCESS_KEY must differ from MINIO_ROOT_USER (that is the whole point of F2)"
  exit 2
fi

$MC alias set --quiet local "$MINIO_URL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
log "bucket $BUCKET"
$MC mb --ignore-existing "local/$BUCKET"

policy_file=$(mktemp)
trap 'rm -f "$policy_file"' EXIT
cat > "$policy_file" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": ["arn:aws:s3:::$BUCKET/*"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucketMultipartUploads",
        "s3:GetBucketLocation"
      ],
      "Resource": ["arn:aws:s3:::$BUCKET"]
    }
  ]
}
JSON

log "policy $POLICY (objects of $BUCKET only)"
# `create` replaces the document when the name already exists, which is what a re-run needs.
$MC admin policy create local "$POLICY" "$policy_file"

log "user $APP_USER"
# `user add` on an existing account resets its secret key: that is how a rotation is applied.
$MC admin user add local "$APP_USER" "$APP_SECRET"

log "attach $POLICY to $APP_USER"
# Already attached is not an error for us; any other failure is.
if ! attach_error=$($MC admin policy attach local "$POLICY" --user "$APP_USER" 2>&1); then
  case "$attach_error" in
    *"already in effect"* | *"already exists"*) log "policy was already attached" ;;
    *) log "attach failed: $attach_error"; exit 1 ;;
  esac
fi

# Fail the service rather than let api/worker start with a user that has no policy.
$MC admin user info local "$APP_USER" >/dev/null

# v6 hardening H3 (agent H): optional lifecycle rule on `selfies/`, only when
# S3_SELFIE_EXPIRE_DAYS is set and non-empty. It carries over what the Coolify stack's
# minio-init did before it was switched to this script (docker-compose.coolify.yml): a kept
# selfie (KEEP_SELFIES) is deleted by the store itself after a day, so the retention promise
# does not depend on a job running. Unset in deploy/compose.yml and docker-compose.yml, where
# this block is skipped and nothing changes.
#
# `mc ilm rule add` does NOT deduplicate: the old inline command in
# docker-compose.coolify.yml added one more identical rule on every single deploy. The
# existing rules are read first, so a re-run is a no-op. `--expire-days` is the current flag
# and `--expiry-days` the older one; a failure only logs, because the rule is a safety net
# and not the only deletion path (the worker deletes selfies itself unless KEEP_SELFIES).
#
# The match is a shell `case`, not `grep`: this runs inside cgr.dev/chainguard/minio, which
# ships `mc`, `sh`, `date` and `mktemp` but NO grep. A grep-based guard here silently never
# matched and kept adding rules — verified, do not reintroduce one.
if [ -n "${S3_SELFIE_EXPIRE_DAYS:-}" ]; then
  existing_rules=$($MC ilm rule ls "local/$BUCKET" --json 2>/dev/null || true)
  case "$existing_rules" in
    *'"Prefix":"selfies/"'*)
      log "lifecycle selfies/ already present"
      ;;
    *)
      log "lifecycle selfies/ expire after ${S3_SELFIE_EXPIRE_DAYS}d"
      $MC ilm rule add --expire-days "$S3_SELFIE_EXPIRE_DAYS" --prefix "selfies/" "local/$BUCKET" \
        || $MC ilm rule add --expiry-days "$S3_SELFIE_EXPIRE_DAYS" --prefix "selfies/" "local/$BUCKET" \
        || log "lifecycle rule not applied (unsupported mc?); continuing"
      ;;
  esac
fi

log "done"
