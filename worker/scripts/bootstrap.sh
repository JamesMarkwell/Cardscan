#!/usr/bin/env bash
#
# One-time setup for the CardScan Worker.
#
# Creates the D1 database and R2 bucket, writes the database id into
# wrangler.toml, applies the migrations, sets the admin token and deploys.
# Safe to re-run: every step checks for what already exists.
#
#   cd worker && ./scripts/bootstrap.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

DATABASE_NAME="${DATABASE_NAME:-cardscan}"
BUCKET_NAME="${BUCKET_NAME:-cardscan-packs}"
WRANGLER="npx wrangler"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking you are logged in to Cloudflare"
if ! $WRANGLER whoami >/dev/null 2>&1; then
  echo "Not logged in. Run:  npx wrangler login"
  echo "(or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)"
  exit 1
fi
$WRANGLER whoami | tail -3

say "Creating the D1 database '$DATABASE_NAME' (skipped if it exists)"
$WRANGLER d1 create "$DATABASE_NAME" 2>/dev/null || echo "Already exists, carrying on."

say "Finding its database id"
DATABASE_ID="$($WRANGLER d1 list --json 2>/dev/null | node -e "
  let raw = '';
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    // wrangler prints banner lines before the JSON on some versions.
    const start = raw.indexOf('[');
    const list = JSON.parse(raw.slice(start));
    const match = list.find((entry) => entry.name === process.env.DATABASE_NAME);
    process.stdout.write(match ? match.uuid : '');
  });
" || true)"

if [ -z "$DATABASE_ID" ]; then
  echo "Could not read the database id automatically."
  echo "Run 'npx wrangler d1 list', copy the uuid for '$DATABASE_NAME',"
  echo "and put it in wrangler.toml as database_id."
  exit 1
fi
echo "database_id = $DATABASE_ID"

say "Writing it into wrangler.toml"
node -e "
  const fs = require('fs');
  const path = 'wrangler.toml';
  const before = fs.readFileSync(path, 'utf8');
  const after = before.replace(
    /^database_id = .*$/m,
    'database_id = \"' + process.env.DATABASE_ID + '\"',
  );
  if (before === after) {
    console.log('wrangler.toml already up to date.');
  } else {
    fs.writeFileSync(path, after);
    console.log('Updated wrangler.toml — commit this change.');
  }
" DATABASE_ID="$DATABASE_ID"

say "Creating the R2 bucket '$BUCKET_NAME' (skipped if it exists)"
$WRANGLER r2 bucket create "$BUCKET_NAME" 2>/dev/null || echo "Already exists, carrying on."

say "Applying migrations"
$WRANGLER d1 migrations apply "$DATABASE_NAME" --remote

say "Setting the admin token"
if [ -n "${WORKER_ADMIN_TOKEN:-}" ]; then
  TOKEN="$WORKER_ADMIN_TOKEN"
  echo "Using the token from your environment."
else
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  echo "Generated a new token. Keep it: you need it as a GitHub secret too."
  echo
  echo "    WORKER_ADMIN_TOKEN=$TOKEN"
  echo
fi
printf '%s' "$TOKEN" | $WRANGLER secret put WORKER_ADMIN_TOKEN

say "Deploying"
$WRANGLER deploy

cat <<NEXT

Done. Next:

  1. Note the workers.dev URL printed just above.
  2. Build the card database (this takes a while the first time):

       curl -X POST "<worker-url>/admin/refresh?game=onepiece" \\
         -H "Authorization: Bearer $TOKEN"

     Leave off ?game= to do every game.

  3. In the app: Settings -> Catalog URL -> paste the worker URL -> Sync.

  4. For nightly fingerprints, add these repository secrets on GitHub
     (Settings -> Secrets and variables -> Actions):

       WORKER_URL            the worker URL
       WORKER_ADMIN_TOKEN    the token above
       R2_ACCOUNT_ID         Cloudflare account id
       R2_ACCESS_KEY_ID      R2 API token key id
       R2_SECRET_ACCESS_KEY  R2 API token secret

NEXT
