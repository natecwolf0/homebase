# Setup (about 20 minutes)

1. **Supabase** — create project `homebase` (East US). SQL Editor -> New query -> paste all of `supabase/schema.sql` -> Run.
   Then Project Settings -> API Keys: copy the Project URL and the *Publishable* key.
2. **Anthropic Console** — create an API key named `homebase`. Keep auto-reload OFF.
3. **GitHub** — create repo `homebase`, put these files in it (without `node_modules` / `.next`).
4. **Vercel** — Add New Project -> import `homebase`. Before deploying, add the three environment variables from `.env.example`. Deploy.
5. Open the Vercel URL -> Backup -> Load file -> pick your backup JSON.
