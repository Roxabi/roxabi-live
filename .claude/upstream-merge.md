# Upstream Merge Policy

Remote: `upstream` -> https://github.com/Roxabi/roxabi_boilerplate.git

## How to pull boilerplate updates

1. `git fetch upstream`
2. `git merge upstream/main` (or `git cherry-pick <sha>` for selective)
3. Resolve conflicts -- highest-risk files:
   - `apps/web/src/routes/`
   - `apps/api/src/`
   - `package.json`
   - `biome.json`
4. `bun install` -- always regenerate bun.lock after merge
5. `git add bun.lock && git commit`

## Deferred strip list (create issues before next upstream merge)
- i18n/Paraglide
- Email / magic-link auth
- Consent banner / GDPR
- Organization management
- Admin panel
