#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build_git.sh - prépare et committe le CODE SOURCE de Kubuno vers Git/GitHub.
#
# N'embarque que le source : tous les artefacts (target/, node_modules/, dist/,
# frontend/dist*, data/, *.deb…) et les secrets (.env, *.key…) sont exclus par
# .gitignore. Un garde-fou refuse de committer un fichier sensible par accident.
#
# Usage :
#   bash build_git.sh "message de commit"            # init si besoin + commit local
#   bash build_git.sh "message de commit" --push     # + push vers le remote origin
#
# Prérequis pour --push : un remote 'origin' configuré et une auth GitHub
#   git remote add origin git@github.com:<user>/kubuno.git     (SSH)
#   ou   https://<user>:<token>@github.com/<user>/kubuno.git   (HTTPS + token)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

MSG="${1:-Update Kubuno}"
PUSH=false
[[ "${2:-}" == "--push" ]] && PUSH=true

# 1. Dépôt git (init au besoin, branche main)
if [ ! -d .git ]; then
  echo "==> Initialisation du dépôt git"
  git init -q
  git branch -M main
fi

# 2. .gitignore obligatoire (sinon on risque de committer des Go d'artefacts)
if [ ! -f .gitignore ]; then
  echo "ERREUR : .gitignore manquant - abandon." >&2
  exit 1
fi

# 3. Identité git (locale au dépôt) si absente
if [ -z "$(git config user.email || true)" ]; then
  echo "ATTENTION : identité git non configurée. Configure-la :" >&2
  echo "  git config user.name  \"Ton Nom\"" >&2
  echo "  git config user.email \"toi@example.com\"" >&2
  exit 1
fi

# 4. Garde-fou secrets : refuse tout fichier sensible sur le point d'être suivi
SECRETS=$(git ls-files --cached --others --exclude-standard \
  | grep -E '(^|/)\.env($|\.local|\.prod|\.production)|\.pem$|\.key$|\.p12$|(^|/)config\.toml$' || true)
if [ -n "$SECRETS" ]; then
  echo "ERREUR : fichiers sensibles sur le point d'être versionnés :" >&2
  echo "$SECRETS" | sed 's/^/  - /' >&2
  echo "Ajoute-les à .gitignore avant de committer." >&2
  exit 1
fi

# 5. Staging + résumé
git add -A
N=$(git status --short | wc -l)
echo "==> $N entrée(s) à committer :"
git status --short | head -40
[ "$N" -gt 40 ] && echo "   … (+$((N - 40)) autres)"

# 6. Commit (uniquement s'il y a des changements indexés)
if git diff --cached --quiet; then
  echo "Rien à committer (arbre propre)."
else
  git commit -q -m "$MSG"
  echo "==> Commit : $MSG"
fi

# 7. Push optionnel
if $PUSH; then
  if git remote get-url origin >/dev/null 2>&1; then
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    echo "==> Push vers origin/$BRANCH…"
    git push -u origin "$BRANCH"
    echo "✓ Poussé."
  else
    echo "Pas de remote 'origin'. Ajoute-le d'abord :" >&2
    echo "  git remote add origin <url-du-dépôt-github>" >&2
    exit 1
  fi
fi
