# LOKRITI JEWELS by Aditi — Railway deployment

This package is the Railway-ready version of the catalogue website. The complete application is included at the repository root.

## What is included

```text
server.js
package.json
railway.toml
nixpacks.toml
migrations/
public/
admin/
schema.sql
.env.example
```

The site remains **catalogue + enquiry only**. There is no cart, checkout, online payment, order placement, or customer purchase flow.

## 1. GitHub

Upload/extract the **contents** of this package into the GitHub repository root. Do not upload only the ZIP file.

At the top level GitHub must show at least:

```text
admin/
migrations/
public/
package.json
railway.toml
nixpacks.toml
schema.sql
server.js
```

`migrations/` and `public/` must be real folders beside `server.js`.

## 2. Railway service

Create/select the Node.js service connected to the GitHub repository.

Railway should detect `package.json` and use the included `railway.toml`. The start command is:

```text
npm start
```

The application listens on Railway's injected `PORT` environment variable.

## 3. MySQL

Add a Railway MySQL service to the same project.

The application accepts Railway's standard MySQL environment variable names:

```text
MYSQLHOST
MYSQLPORT
MYSQLDATABASE
MYSQLUSER
MYSQLPASSWORD
```

It also accepts `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` if variables are mapped manually.

On startup the application automatically runs every numbered SQL file in `migrations/` that has not already been applied.

## 4. Required secrets

In the Node.js service Variables, set:

```text
NODE_ENV=production
JWT_SECRET=<random secret at least 32 characters>
RATE_LIMIT_SECRET=<different random secret at least 32 characters>
ADMIN_EMAIL=<your private admin email>
ADMIN_PASSWORD_HASH=<bcrypt hash of a new strong admin password>
```

Never commit real passwords, JWT secrets, database passwords, or SMTP credentials to GitHub.

## 5. Public URL testing

Railway can generate a temporary public domain for the service. For the first test, set:

```text
PUBLIC_BASE_URL=https://YOUR-RAILWAY-DOMAIN.up.railway.app
PRIMARY_HOST=YOUR-RAILWAY-DOMAIN.up.railway.app
```

After the real domain is connected, change both values to:

```text
PUBLIC_BASE_URL=https://lokritijewels.com
PRIMARY_HOST=lokritijewels.com
```

The application also understands Railway's `RAILWAY_PUBLIC_DOMAIN` as a fallback when `PUBLIC_BASE_URL` is not explicitly set.

## 6. Health check

Open:

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/health
```

A healthy database connection returns JSON containing:

```json
{"ok":true,"database":"ok"}
```

If it reports `starting` or `error`, check the MySQL service and the variables before connecting the custom domain.

## 7. Persistent product uploads

The bundled editorial/home images are part of `public/assets` and do not need a volume.

Admin-uploaded product images use local storage by default. For those uploads to survive Railway redeploys, attach a Railway Volume to the Node service and mount it at:

```text
/data
```

The included environment example then uses:

```text
DATA_DIR=/data/lokriti-data
UPLOAD_DIR=/data/lokriti-data/uploads
```

If you do not want a Railway Volume, use S3-compatible storage instead by setting `STORAGE_DRIVER=s3` and its S3 variables. Without either a Volume or object storage, admin-uploaded files on local disk should be treated as temporary.

## 8. Domain

Do not change GoDaddy DNS until the Railway temporary URL works and `/api/health` is healthy.

When the app is working, use Railway's **Custom Domain** screen and copy the exact DNS records Railway provides. Do not invent DNS values.

## 9. Expected website structure

The public website includes:

- Home
- Shop
- Bridal
- Our Story
- FAQ
- Contact
- Shipping
- Returns
- Jewellery Care
- Terms
- Privacy

The Shop intentionally starts empty. The supplied editorial photographs are not seeded as catalogue products.

## 10. Final test sequence

1. Railway deployment succeeds.
2. Railway logs show the server listening on the injected port.
3. `/api/health` returns database `ok`.
4. Railway public URL opens Home.
5. Homepage images load.
6. Navigation works.
7. Shop shows the intended empty state.
8. Contact page loads and enquiry storage works.
9. `/admin` is accessible only directly and is not in public navigation.
10. Only after the above works, connect `lokritijewels.com` through Railway Custom Domain.

## Important

This package is for Railway. It is not necessary to put these files into a PHP `public_html` directory. Railway runs `server.js` as a Node.js service.
