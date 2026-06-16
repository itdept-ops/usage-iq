#!/usr/bin/env bash
# Runs ON the EC2 host (invoked by GitHub Actions via SSM). Pulls config/secrets from SSM
# Parameter Store, logs in to ECR, and (re)starts the stack with the freshly-pushed images.
set -euo pipefail

REGION=us-west-2
ACCT=398152420190
ECR="$ACCT.dkr.ecr.$REGION.amazonaws.com"

cd "$(cd "$(dirname "$0")" && pwd)"   # the deploy/ directory of the checkout

# Fetch a Parameter Store value; prints empty string if it is not set yet.
ssm() { aws ssm get-parameter --region "$REGION" --name "$1" "${@:2}" --query Parameter.Value --output text 2>/dev/null || true; }

JWT=$(ssm /usage-iq/jwt-key --with-decryption)
DBPW=$(ssm /usage-iq/db-password --with-decryption)
DOMAIN=$(ssm /usage-iq/domain);                 DOMAIN=${DOMAIN:-usageiq.online}
ADMIN_EMAIL=$(ssm /usage-iq/admin-email);        ADMIN_EMAIL=${ADMIN_EMAIL:-it_dept@eqchomecare.com}
GOOGLE_ID=$(ssm /usage-iq/google-client-id)
GOOGLE_SECRET=$(ssm /usage-iq/google-client-secret --with-decryption)

if [ -z "$JWT" ] || [ -z "$DBPW" ]; then
  echo "FATAL: /usage-iq/jwt-key or /usage-iq/db-password missing in SSM." >&2; exit 1
fi

umask 077
cat > .env <<EOF
ECR=$ECR
DB_PASSWORD=$DBPW
JWT_KEY=$JWT
DOMAIN=$DOMAIN
ACME_EMAIL=$ADMIN_EMAIL
ADMIN_EMAIL=$ADMIN_EMAIL
GOOGLE_CLIENT_ID=$GOOGLE_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_SECRET
EOF

echo "==> Logging in to ECR"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR"

echo "==> Pulling images + starting the stack ($DOMAIN)"
docker compose -f docker-compose.prod.yml --env-file .env pull
docker compose -f docker-compose.prod.yml --env-file .env up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo "==> Done. Containers:"
docker compose -f docker-compose.prod.yml --env-file .env ps
[ -z "$GOOGLE_ID" ] && echo "NOTE: Google sign-in not configured yet (set /usage-iq/google-client-id + -secret in SSM, then redeploy)."
echo "Deploy OK."
