# RePhoto backup sidecar: pg_dump (matching the pgvector/pg16 server) + MinIO client.
# `mc` is a static Go binary; it is copied from the same MinIO image the stack runs.
FROM cgr.dev/chainguard/minio:latest AS mc

FROM postgres:16-alpine
COPY --from=mc /usr/bin/mc /usr/local/bin/mc
COPY rephoto-backup /usr/local/bin/rephoto-backup
RUN chmod 0755 /usr/local/bin/rephoto-backup && mkdir -p /backup
# Runs as root: /backup is a bind mount of ${BACKUP_DIR}, owned by the host user (bootstrap.sh
# creates it for `rephoto`), so a fixed in-image uid could not write there. pg_dump/pg_restore
# authenticate with PG* env, not the OS user. The container has no port and is internal only.
VOLUME ["/backup"]
ENTRYPOINT ["/usr/local/bin/rephoto-backup"]
CMD ["loop"]
