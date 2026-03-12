# Flavor Fusion Chef

Flavor Fusion Chef is a Next.js web app that takes a base recipe and generates a structured fusion version using AI.

You can:
- Generate a fusion recipe from free-text input
- Reroll variations
- Save recipes to a cookbook
- Generate and store recipe images
- Manage shopping list checkboxes per recipe

## 1. Tech Stack

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS v4
- OpenAI API (text + image generation)
- Turso (cookbook database)
- Cloudflare R2 (image storage)

## 2. Prerequisites

Install these before running:
- Node.js 20+ (LTS recommended)
- npm (comes with Node)
- Git

Optional but recommended:
- VS Code
- Vercel account (for production deployment)

## 3. Project Setup (Local)

From your project folder:

```bash
npm install
```

Create this file:

```bash
.env.local
```

Add the required environment variables (see next section), then run:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## 4. Environment Variables

Create `.env.local` and add:

```bash
# OpenAI
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-1

# Turso (cookbook DB)
TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...

# Cloudflare R2 (image storage)
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=fusion-cooking
R2_PUBLIC_BASE_URL=https://<your-public-r2-domain>

# Internal-only API protection (health + cleanup routes)
INTERNAL_API_TOKEN=...

# Optional cron route protection
CRON_SECRET=...

# Optional rate limit backend (default is turso in this project)
RATE_LIMIT_BACKEND=turso

# Optional DB query timeout (ms)
TURSO_QUERY_TIMEOUT_MS=8000
```

## 5. Available Scripts

```bash
npm run dev        # start local development server
npm run lint       # run ESLint
npm run typecheck  # run TypeScript checks
npm run build      # production build check
npm run start      # run production server (after build)
```

## 6. Core User Flow

1. User enters a recipe on Home
2. App calls `/api/fuse` to generate structured recipe JSON
3. Result page displays sections (ingredients, steps, swaps, nutrition, shopping list)
4. Image is generated with `/api/fuse-image`
5. On "Save to Cookbook":
   - image uploads to R2
   - recipe saves to Turso
6. Cookbook list/detail are read from server APIs

## 7. Data Storage Design

- Temporary generated recipe state:
  - browser storage (for in-session result flow)
- Saved cookbook:
  - Turso database (server-side, persistent)
- Saved recipe images:
  - Cloudflare R2 (server-side object storage)

## 8. API Routes (High Level)

- `POST /api/fuse`  
  Generate fusion recipe JSON (strict schema)

- `POST /api/fuse-image`  
  Generate recipe image preview

- `GET /api/cookbook`  
  Get paginated cookbook summaries (cursor pagination)

- `POST /api/cookbook`  
  Save/upsert recipe into cookbook

- `GET /api/cookbook/[id]`  
  Get single saved recipe

- `DELETE /api/cookbook/[id]`  
  Delete recipe and its R2 image

- `POST /api/r2-upload`  
  Upload optimized image to R2

- `POST /api/r2-delete`  
  Delete R2 image by URL

- `GET /api/r2-health`  
  Internal health test for R2 credentials/access

- `GET|POST /api/r2-orphan-cleanup`  
  Internal manual cleanup for orphaned images

- `GET /api/cron/r2-orphan-cleanup`  
  Scheduled cleanup endpoint (used by Vercel Cron)

## 9. Security and Reliability Notes

- Rate limiting is applied to sensitive routes
- Request body size limits are enforced
- Idempotency is used on key write operations
- ETag + cache-control used on cookbook list/detail responses
- Orphan image cleanup is supported (manual + scheduled)

## 10. Deploy to GitHub -> Vercel

### A. Push to GitHub

```bash
git init
git add .
git commit -m "Initial production-ready setup"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

### B. Deploy on Vercel

1. Go to Vercel dashboard
2. Import your GitHub repository
3. Framework: Next.js (auto-detected)
4. Add all environment variables from `.env.local`
5. Deploy

### C. Post-deploy checks

- Home fuse flow works
- Reroll works
- Save to cookbook works
- Cookbook open/delete works
- R2 image upload/delete works

## 11. Troubleshooting

- **PowerShell blocks `npm` scripts (execution policy)**  
  Use `npm.cmd`:
  ```bash
  npm.cmd run dev
  ```

- **`OPENAI_API_KEY is missing`**  
  Add key to `.env.local` and restart dev server.

- **Turso errors / table not found**  
  Confirm `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are correct, then restart.

- **Image upload/delete failing**  
  Verify all R2 env vars and `R2_PUBLIC_BASE_URL`.

- **Internal route returns `Not found.`**  
  Send header:
  ```text
  x-internal-token: <INTERNAL_API_TOKEN>
  ```

## 12. Notes for Production

- Never commit `.env.local`
- Use Vercel environment variable manager for prod secrets
- Keep cron enabled for orphan cleanup (`vercel.json`)
- Add custom domain for R2 in production (recommended)
