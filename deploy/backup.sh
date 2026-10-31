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
#   - The documents volume (content-addressed blobs, 0004) is tarred read-only
#     from a throwaway container. The dump and the tarball are one backup SET:
#     the rows link to the documents, and neither restores the other.
#   - Every artifact is written to a .partial name and validated (pg_restore
#     can list the dump; tar can read the archive to its end) before any of
#     them is published. The set's manifest, <base>.sha256, is published last:
#     a set is COMPLETE only when its manifest is there and names a dump and
#     an archive per volume that all exist. A failed run publishes nothing,
#     never pushes a good set out, and leaves a FAILED marker in its directory
#     (cleared by the next good run of the same kind). TERM/INT/HUP count as
#     failure. A run killed outright (no trap runs) is caught by its
#     RUNNING.<base> marker, written at start with the run's pid and removed
#     when it ends: --status fails on one whose pid is gone, and shows a live
#     one as running.
#   - Retention: DAILY_KEEP complete dailies; the set taken on the 1st is also
#     kept as a monthly, MONTHLY_KEEP of them. Only complete sets count;
#     once there are that many, anything older than the oldest kept set
#     (failed or pre-manifest leftovers too) goes.
#   - Needs bash 4, coreutils (sha256sum) and tar with gzip on the host.
#
# USAGE
#   backup.sh              # take a backup set, apply retention
#   backup.sh --tag NAME   # extra set outside retention (pre-deploy)
#   backup.sh --status     # what is held; exits non-zero unless the newest
#                          # complete daily set verifies and is fresh, and the
#                          # last daily and tagged runs succeeded (none was
#                          # interrupted; a live run shows as RUNNING)
#
# RESTORE
#   cd ~/backups/hovedbok/daily && sha256sum -c hovedbok-YYYYMMDD-HHMMSS.sha256
#   cd <stack dir>
#   docker compose exec -T db sh -c 'pg_restore -U hovedbok -d hovedbok --clean --if-exists' \
#     < ~/backups/hovedbok/daily/hovedbok-YYYYMMDD-HHMMSS.dump
#   docker run --rm -v hovedbok-prod_documents:/dst -v ~/backups/hovedbok/daily:/src:ro \
#     alpine:3 tar -xzf /src/hovedbok-YYYYMMDD-HHMMSS.documents.tar.gz -C /dst
set -euo pipefail
export LC_ALL=C # names sort and compare by byte: they sort by time

STACK_DIR="${HOVEDBOK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="${HOVEDBOK_BACKUP_DEST:-$HOME/backups/hovedbok}"
DAILY_KEEP="${HOVEDBOK_BACKUP_DAILY_KEEP:-14}"
MONTHLY_KEEP="${HOVEDBOK_BACKUP_MONTHLY_KEEP:-6}"
STALE_HOURS="${HOVEDBOK_BACKUP_STALE_HOURS:-36}"
PROJECT="${COMPOSE_PROJECT_NAME:-hovedbok-prod}"
VOLUMES="${PROJECT}_documents"

for n in "$DAILY_KEEP" "$MONTHLY_KEEP" "$STALE_HOURS"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "keep counts and stale hours must be positive integers" >&2; exit 2; }
done

# A set is complete when its manifest names the dump and an archive for every
# volume, and every file it names exists.
set_complete() { # manifest
  local m="$1" dir base v f
  dir="$(dirname "$m")"; base="$(basename "$m" .sha256)"
  grep -q "^[0-9a-f]\{64\}  $base\.dump\$" "$m" || return 1
  for v in $VOLUMES; do
    grep -q "^[0-9a-f]\{64\}  $base\.${v#"${PROJECT}_"}\.tar\.gz\$" "$m" || return 1
  done
  while read -r _ f; do
    [ -f "$dir/$f" ] || return 1
  done < "$m"
}

# Complete, and the bytes are the ones validated at backup time: checksums
# match and every archive still reads to its end.
verify_set() { # manifest
  local m="$1" dir f
  set_complete "$m" || return 1
  dir="$(dirname "$m")"
  (cd "$dir" && sha256sum --quiet --strict -c "$(basename "$m")") || return 1
  while read -r _ f; do
    case "$f" in
      *.tar.gz) tar -tzf "$dir/$f" > /dev/null || return 1 ;;
    esac
  done < "$m"
}

complete_sets() { # dir — manifests of complete sets, oldest first (names sort by time)
  local m
  find "$1" -maxdepth 1 -type f -name 'hovedbok-*.sha256' | sort | while read -r m; do
    if set_complete "$m"; then echo "$m"; fi
  done
}

incomplete_bases() { # dir — published artifacts that belong to no complete set
  local dir="$1" f b
  find "$dir" -maxdepth 1 -type f \( -name 'hovedbok-*.dump' -o -name 'hovedbok-*.tar.gz' -o -name 'hovedbok-*.sha256' \) |
    while read -r f; do
      f="$(basename "$f")"
      case "$f" in
        *.dump) b="${f%.dump}" ;;
        *.sha256) b="${f%.sha256}" ;;
        *) b="${f%.*.tar.gz}" ;;
      esac
      if ! { [ -f "$dir/$b.sha256" ] && set_complete "$dir/$b.sha256"; }; then echo "$b"; fi
    done | sort -u
}

running_markers() { # dir — RUNNING.<base> markers of runs that have not ended
  [ -d "$1" ] || return 0
  find "$1" -maxdepth 1 -type f -name 'RUNNING.hovedbok-*' | sort
}

alive() { # pid
  [[ "$1" =~ ^[0-9]+$ ]] && { kill -0 "$1" 2>/dev/null || [ -d "/proc/$1" ]; }
}

status() {
  local rc=0 d b m sets incomplete newest newest_base age
  for d in daily monthly tagged; do
    [ -d "$DEST/$d" ] || continue
    sets="$(complete_sets "$DEST/$d" | wc -l)"
    incomplete="$(incomplete_bases "$DEST/$d" | wc -l)"
    printf '%-8s %3d complete sets, %d incomplete, %s\n' "$d" "$sets" "$incomplete" \
      "$(du -sh "$DEST/$d" | cut -f1)"
  done
  for d in daily tagged; do
    if [ -f "$DEST/$d/FAILED" ]; then
      echo "FAILED: last $d run: $(cat "$DEST/$d/FAILED")"; rc=1
    fi
    while read -r m; do
      if alive "$(cat "$m")"; then
        echo "RUNNING: ${m##*/RUNNING.} (pid $(cat "$m"))"
      else
        echo "INTERRUPTED: ${m##*/RUNNING.} died without finishing (pid $(cat "$m") is gone)"; rc=1
      fi
    done < <(running_markers "$DEST/$d")
  done
  [ -d "$DEST/daily" ] && newest="$(complete_sets "$DEST/daily" | tail -1)"
  if [ -z "${newest:-}" ]; then
    echo "NO COMPLETE DAILY SET"; return 1
  fi
  newest_base="$(basename "$newest" .sha256)"
  age=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
  echo "newest: $DEST/daily/$newest_base (${age}h old)"
  if ! verify_set "$newest"; then
    echo "CORRUPT: $newest_base fails its checksums or an archive does not read"; rc=1
  fi
  # A set started after the newest complete one and never finished: a run
  # that died without leaving its FAILED marker.
  while read -r b; do
    if [[ "$b" > "$newest_base" ]]; then
      echo "INCOMPLETE: $b is newer than the newest complete set"; rc=1
    fi
  done < <(incomplete_bases "$DEST/daily")
  [ "$age" -le "$STALE_HOURS" ] || { echo "STALE: older than ${STALE_HOURS}h"; rc=1; }
  return "$rc"
}

prune() { # dir, keep — the newest `keep` complete sets stay; everything older goes
  local dir="$1" keep="$2" oldest pattern f
  # Until `keep` complete sets exist, nothing goes: whatever else is there
  # (a set from before manifests, say) may be all there is.
  [ "$(complete_sets "$dir" | wc -l)" -ge "$keep" ] || return 0
  oldest="$(complete_sets "$dir" | tail -n "$keep" | head -1)"
  oldest="$(basename "$oldest" .sha256)"
  # Manifests first: a prune cut short leaves incomplete sets, never a
  # manifest naming files that are gone.
  for pattern in 'hovedbok-*.sha256' 'hovedbok-*'; do
    find "$dir" -maxdepth 1 -type f -name "$pattern" | while read -r f; do
      if [[ "$(basename "$f")" < "$oldest" ]]; then rm -f "$f"; fi
    done
  done
}

TAG=""
case "${1:-}" in
  --status) status; exit ;;
  --tag)
    TAG="${2:?--tag needs a name}"
    [[ "$TAG" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "--tag takes letters, digits, _ and -" >&2; exit 2; }
    ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

umask 077
mkdir -p "$DEST/monthly"
DEST="$(cd "$DEST" && pwd)" # the dump is written after cd to the stack dir

stamp="$(date +%Y%m%d-%H%M%S)"
if [ -n "$TAG" ]; then
  out="$DEST/tagged"; base="hovedbok-$stamp-$TAG"
else
  out="$DEST/daily"; base="hovedbok-$stamp"
fi

temps=()      # .partial files: never left behind
published=()  # final names of this run's set: withdrawn if its manifest is not
complete=""

finish() {
  local rc=$?
  set +e
  rm -f ${temps[@]+"${temps[@]}"}
  if [ "$rc" -eq 0 ]; then
    rm -f "$out/FAILED"
    # Runs killed before this one are superseded by it, as FAILED is.
    running_markers "$out" | while read -r m; do
      [ "$m" = "$out/RUNNING.$base" ] || alive "$(cat "$m")" || rm -f "$m"
    done
  else
    [ -n "$complete" ] || rm -f ${published[@]+"${published[@]}"}
    printf '%s %s exit %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$base" "$rc" 2>/dev/null > "$out/FAILED"
    echo "FAILED $base (exit $rc)" >&2
  fi
  rm -f "$out/RUNNING.$base"
  exit "$rc"
}
trap finish EXIT
# A signal ends the run as a failure (bash runs the trap once the foreground
# command returns), never as a success.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$out"
echo "$$" > "$out/RUNNING.$base"
if [ -e "$out/$base.sha256" ]; then
  echo "$out/$base.sha256 already exists" >&2; exit 1
fi

cd "$STACK_DIR"
dump="$out/$base.dump"
temps+=("$dump.partial")
docker compose exec -T db sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$dump.partial"
# A dump pg_restore cannot list is not a backup.
docker compose exec -T db pg_restore -l < "$dump.partial" > /dev/null

archives=()
for v in $VOLUMES; do
  archive="$out/$base.${v#"${PROJECT}_"}.tar.gz"
  temps+=("$archive.partial")
  docker run --rm -v "$v:/src:ro" alpine:3 tar -czf - -C /src . > "$archive.partial"
  # Nor is an archive tar cannot read to its end.
  tar -tzf "$archive.partial" > /dev/null
  archives+=("$archive")
done

# Publish: the artifacts, then the manifest that makes them a set.
temps+=("$out/$base.sha256.partial")
: > "$out/$base.sha256.partial"
for f in "$dump" "${archives[@]}"; do
  sum="$(sha256sum < "$f.partial")"
  printf '%s  %s\n' "${sum%% *}" "$(basename "$f")" >> "$out/$base.sha256.partial"
done
for f in "$dump" "${archives[@]}"; do
  published+=("$f")
  mv "$f.partial" "$f"
done
mv "$out/$base.sha256.partial" "$out/$base.sha256"
complete=1

if [ -z "$TAG" ]; then
  if [ "${stamp:6:2}" = "01" ]; then
    # Same order into monthly: copies under .partial names, the manifest last.
    for f in "$dump" "${archives[@]}" "$out/$base.sha256"; do
      temps+=("$DEST/monthly/$(basename "$f").partial")
      cp -p "$f" "$DEST/monthly/$(basename "$f").partial"
    done
    for f in "$dump" "${archives[@]}" "$out/$base.sha256"; do
      mv "$DEST/monthly/$(basename "$f").partial" "$DEST/monthly/$(basename "$f")"
    done
  fi
  prune "$DEST/daily" "$DAILY_KEEP"
  prune "$DEST/monthly" "$MONTHLY_KEEP"
fi

echo "OK $out/$base ($(du -ch "$dump" "${archives[@]}" | tail -1 | cut -f1))"
