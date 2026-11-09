#!/bin/bash
# Installe (ou met à jour) le relais gratuit AdTok sur ton compte Cloudflare.
# À lancer depuis le Mac :  bash ~/Projects/AdTok/worker/deploy.sh
set -e
cd "$(dirname "$0")"

echo "1/4  Connexion à Cloudflare (une page s'ouvre dans ton navigateur, clique sur Allow)…"
npx --yes wrangler@3 whoami >/dev/null 2>&1 || npx --yes wrangler@3 login

echo "2/4  Mise en ligne du relais…"
npx --yes wrangler@3 deploy | tee /tmp/adtok-deploy.log
URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' /tmp/adtok-deploy.log | head -1)

echo "3/4  Token Meta (celui qui a accès à la Ad Library)…"
if [ -n "$META_TOKEN" ]; then
  printf '%s' "$META_TOKEN" | npx --yes wrangler@3 secret put META_TOKEN
else
  npx --yes wrangler@3 secret put META_TOKEN   # colle le token quand c'est demandé
fi

echo "4/4  Clé du relais (mot de passe entre l'app et le relais)…"
KEY=$(openssl rand -hex 16)
printf '%s' "$KEY" | npx --yes wrangler@3 secret put APP_KEY

echo
echo "C'est prêt. Dans AdTok → Réglages → Source des ads → « Meta gratuit » :"
echo "   Adresse du relais : $URL"
echo "   Clé du relais     : $KEY"
echo "Puis « Tester le relais »."
