#!/bin/bash
# Palyam - Quick deploy script
# Pushes local database and code changes to GitHub → Render auto-deploys

echo "🚀 Palyam Deploy"
echo "================"

cd "$(dirname "$0")"

# Check for changes
if git diff --quiet catalog.db && git diff --quiet --cached catalog.db && [ -z "$(git status --porcelain)" ]; then
  echo "✅ אין שינויים לדחוף"
  exit 0
fi

echo ""
echo "📦 שינויים שנמצאו:"
git status --short
echo ""

# Stage everything
git add catalog.db
git add -A

# Commit
TIMESTAMP=$(date +"%Y-%m-%d %H:%M")
git commit -m "Update data - $TIMESTAMP"

# Push
echo ""
echo "⬆️  דוחף ל-GitHub..."
git push

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ הצלחה! Render יתעדכן אוטומטית תוך 1-2 דקות"
  echo "🌐 https://faucet-catalog.onrender.com"
else
  echo ""
  echo "❌ שגיאה בדחיפה ל-GitHub"
  exit 1
fi
