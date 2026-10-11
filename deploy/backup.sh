#!/usr/bin/env bash
# backup.sh — nightly dump of the hovedbok database and its documents volume.
#
# WHY
#   Bokføringsforskriften § 7-2: the bookkeeper must secure the records against
#   loss. The journal is append-only in the database, but a bad migration or a
#   `down -v` is not. Same disk as the data: this protects against us, not
#   against the disk.
#
# DESIGN (as the host's securo-backup.sh)
#   - pg_dump -Fc through `docker compose exec`, so the server's own pg_dump
#     version is used and no client is needed on the host.
#   - Written to a .partial name and renamed only once pg_restore can list it:
#     a half-written dump never counts and never pushes a good one out.
#   - The documents volume (content-addressed blobs, 0004) is tarred read-only
#     from a throwaway container, next to the dump it belongs with.
#   - Retention: DAILY_KEEP dailies; the dump taken on the 1st is also kept as
#     a monthly, MONTHLY_KEEP of them.
#
# USAGE
#   backup.sh              # take a backup, apply retention
#   backup.sh --tag NAME   # extra dump outside retention (pre-deploy)
#   backup.sh --status     # what is held; exits non-zero if the newest is stale
#
# RESTORE
#   cd <stack dir>
#   docker compose exec -T db sh -c 'pg_restore -U hovedbok -d hovedbok --clean --if-exists' \
#     < ~/backups/hovedbok/daily/hovedbok-YYYYMMDD-HHMMSS.dump
#   docker run --rm -v hovedbok-prod_documents:/dst -v ~/backups/hovedbok/daily:/src:ro \
#     alpine:3 tar -xzf /src/hovedbok-YYYYMMDD-HHMMSS.documents.tar.gz -C /dst
set -euo pipefail

STACK_DIR="${HOVEDBOK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="${HOVEDBOK_BACKUP_DEST:-$HOME/backups/hovedbok}"
DAILY_KEEP="${HOVEDBOK_BACKUP_DAILY_KEEP:-14}"
MONTHLY_KEEP="${HOVEDBOK_BACKUP_MONTHLY_KEEP:-6}"
STALE_HOURS="${HOVEDBOK_BACKUP_STALE_HOURS:-36}"
PROJECT="${COMPOSE_PROJECT_NAME:-hovedbok-prod}"
VOLUMES="${PROJECT}_documents"

status() {
  local newest age
  for d in daily monthly tagged; do
    [ -d "$DEST/$d" ] || continue
    printf '%-8s %3d dumps, %s\n' "$d" \
      "$(find "$DEST/$d" -name '*.dump' | wc -l)" \
      "$(du -sh "$DEST/$d" | cut -f1)"
  done
  newest="$(find "$DEST/daily" -name '*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1)"
  if [ -z "$newest" ]; then
    echo "NO DAILY DUMP"; return 1
  fi
  age=$(( ( $(date +%s) - ${newest%%.*} ) / 3600 ))
  echo "newest: ${newest#* } (${age}h old)"
  [ "$age" -le "$STALE_HOURS" ] || { echo "STALE: older than ${STALE_HOURS}h"; return 1; }
}

prune() { # dir, keep — by name, which sorts by time
  find "$1" -name 'hovedbok-*.dump' | sort | head -n "-$2" | while read -r f; do
    rm -f "$f" "${f%.dump}".*.tar.gz
  done
}

TAG=""
case "${1:-}" in
  --status) status; exit ;;
  --tag) TAG="${2:?--tag needs a name}" ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

stamp="$(date +%Y%m%d-%H%M%S)"
if [ -n "$TAG" ]; then
  out="$DEST/tagged"; base="hovedbok-$stamp-$TAG"
else
  out="$DEST/daily"; base="hovedbok-$stamp"
fi
mkdir -p "$out" "$DEST/monthly"
umask 077

cd "$STACK_DIR"
docker compose exec -T db sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$out/$base.dump.partial"
# A dump pg_restore cannot list is not a backup.
docker compose exec -T db pg_restore -l < "$out/$base.dump.partial" > /dev/null
mv "$out/$base.dump.partial" "$out/$base.dump"

for v in $VOLUMES; do
  docker run --rm -v "$v:/src:ro" alpine:3 tar -czf - -C /src . \
    > "$out/$base.${v#"${PROJECT}_"}.tar.gz"
done

if [ -z "$TAG" ]; then
  if [ "$(date +%d)" = "01" ]; then
    cp -p "$out/$base".* "$DEST/monthly/"
  fi
  prune "$DEST/daily" "$DAILY_KEEP"
  prune "$DEST/monthly" "$MONTHLY_KEEP"
fi

echo "OK $out/$base.dump ($(du -h "$out/$base.dump" | cut -f1))"
