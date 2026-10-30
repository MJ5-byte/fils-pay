#!/bin/bash
# Runs ON the OutVibe box. Reads a git archive tarball of $1 (a commit SHA)
# on stdin, backs up the database, deploys it, smoke-tests the public URL,
# and rolls back to the previously deployed tarball if the smoke test fails.
# The box's own secrets (ops/.env.docker, ops/.env) are never overwritten.
set -uo pipefail
SHA="$1"
URL="${FILSPAY_PUBLIC_URL:?set FILSPAY_PUBLIC_URL to the https URL the smoke test calls}"
APP=~/filspay
TARS=~/deploys
COMPOSE="sudo docker compose -f ops/docker-compose.yml"
exec 9>/tmp/filspay-deploy.lock
flock -n 9 || { echo "BUSY another deploy is running"; exit 75; }
mkdir -p "$TARS"
PREV=$(cat "$APP/DEPLOYED_SHA" 2>/dev/null || echo none)
if [ "$PREV" = "$SHA" ]; then cat >/dev/null; echo "SAME already at $SHA"; exit 0; fi
cat > "$TARS/$SHA.tar"
[ -s "$TARS/$SHA.tar" ] || { echo "FAIL empty archive"; exit 1; }

# Build every image while the old containers keep serving, then replace the
# services one at a time: migrate runs to completion first, redis comes up, api and then
# api-2 are recreated and each waited on until its healthcheck passes, so one
# replica always serves while the other restarts, and web goes last so the front
# door is only swapped once the api behind it answers. A plain `up --build`
# stopped web and api together for the whole build (BHA-218).
extract_and_up() {
  tar x -C "$APP" --exclude=ops/.env.docker --exclude=ops/.env -f "$TARS/$1.tar" &&
  (cd "$APP" && {
    $COMPOSE build &&
    $COMPOSE up -d --wait postgres &&
    $COMPOSE up -d --no-deps migrate &&
    [ "$(sudo docker wait "$($COMPOSE ps -aq migrate)")" = 0 ] &&
    # The cache comes up before the api replicas that use it. Not fatal: the
    # api serves from the database without it, so a cache that will not start
    # never blocks or rolls back a deploy.
    { $COMPOSE up -d --no-deps --wait redis || echo "WARN redis not healthy, the api runs without its cache"; } &&
    $COMPOSE up -d --no-deps --wait --remove-orphans api &&
    # grep reads the whole list: with pipefail, grep -q exiting early can kill
    # compose with SIGPIPE and silently skip api-2.
    if $COMPOSE config --services | grep -x api-2 >/dev/null; then $COMPOSE up -d --no-deps --wait api-2; fi &&
    $COMPOSE up -d --no-deps settlement reporting &&
    $COMPOSE up -d --no-deps --wait web
  } >"$TARS/$1.build.log" 2>&1)
}
smoke() {
  for i in $(seq 1 30); do
    r=$(curl -s -o /dev/null -w '%{http_code}' "$URL/readyz")
    d=$(curl -s -o /dev/null -w '%{http_code}' "$URL/dashboard")
    root=$(curl -s -o /dev/null -w '%{http_code}' "$URL/")
    [ "$r" = 200 ] && [ "$d" = 200 ] && [ "$root" = 302 ] && return 0
    sleep 5
  done
  echo "smoke last: readyz=$r dashboard=$d root=$root"; return 1
}

bash ~/backups/pgdump.sh >/dev/null 2>&1 || { echo "FAIL pre-deploy backup failed, not deploying"; exit 1; }
if extract_and_up "$SHA" && smoke; then
  echo "$SHA" > "$APP/DEPLOYED_SHA"
  ls -t "$TARS"/*.tar | tail -n +6 | xargs -r rm -f
  echo "OK deployed $SHA"; exit 0
fi
echo "FAIL $SHA, see $TARS/$SHA.build.log; rolling back to $PREV"
if [ -f "$TARS/$PREV.tar" ] && extract_and_up "$PREV" && smoke; then
  echo "ROLLEDBACK to $PREV"; exit 2
fi
echo "ROLLBACK FAILED, box needs a human"; exit 3
