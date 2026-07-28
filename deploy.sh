#!/bin/bash
set -e

echo "🔨 Building..."
npm run build

echo "✅ Build successful!"
echo "📝 Next steps:"
echo "  1. Commit changes: git add -A && git commit -m 'Sprint 4: Testing + Deployment + Hermes Automation'"
echo "  2. Push to main: git push origin main"
echo "  3. Deploy to Vercel: vercel deploy --prod"
echo ""
echo "🧪 To run tests locally:"
echo "  npm run test:e2e"
echo ""
echo "📊 View test results:"
echo "  npx playwright show-report"
