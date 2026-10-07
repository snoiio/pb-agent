PB Agent — phone-only setup

1. Get the code onto GitHub (from your phone browser)
1. Go to github.com → sign in → "+" → "New repository" → name it `pb-agent` → Public → Create.
2. In the repo: "Add file" → "Create new file".
3. For EACH file in this folder, create the file with the same path and paste its contents:
   - package.json
   - app/layout.tsx
   - app/page.tsx
   - app/api/chat/route.ts

2. Deploy to Vercel
1. vercel.com → "Continue with GitHub" (same account).
2. "Add New" → "Project" → Import `pb-agent`.
3. Environment Variables → add: OPENROUTER_API_KEY = your key from openrouter.ai/keys.
4. Deploy. Done — you get a URL like pb-agent.vercel.app.

3. Chat from your phone
Open the URL. Tell PB things; she'll call her `remember` tool automatically when you share something worth keeping.

Editing code later from your phone
- Easiest: GitHub mobile web → your file → pencil icon → edit → commit. Vercel redeploys automatically.
- Or ask an AI assistant to rewrite a file, then paste it over the old one on GitHub.

Next steps (when ready)
- Persistent memory: replace the in-memory `facts` array with a Neon Postgres table.
- Web search tool: add a search API (e.g. Exa or Brave key) as another tool.
- Telegram: put a bot webhook in front of app/api/chat/route.ts.
- Proactive: Vercel Cron hitting a route that makes her message you first.
