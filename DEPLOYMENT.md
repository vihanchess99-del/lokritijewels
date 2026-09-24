# LOKRITI JEWELS by Aditi — Hostinger deployment

This is the **catalogue + editorial + enquiry** edition of the website.

## What is intentionally removed

There is **no online order placement, cart, checkout, payment gateway, Razorpay integration, order table, or customer purchase flow** in this build. The site is for viewing the jewellery world and sending client enquiries.

The public Shop starts empty, exactly as requested. Products can later be added privately through `/admin`.

## 1. Hostinger

Use Hostinger **Node.js Web App** hosting (Business Web Hosting or a Cloud plan with Node.js Web Apps). Select Node.js 20+ for this project. Do **not** simply copy the ZIP into `public_html` as if this were a PHP/static site: the Node application must be created in Hostinger's Node.js Web App deployment flow.

## 2. Upload

In Hostinger: **Websites → Add website → Node.js Web App → Upload your website files**. Upload this ZIP. Hostinger's current Node.js deployment flow supports ZIP upload and lets you configure the entry/start settings before deployment. Keep this structure at the app root:

```text
server.js
package.json
public/
admin/
```

## 3. Install

```bash
npm install --omit=dev
```

## 4. MySQL

Create a managed MySQL database in Hostinger. Enter these values in Hostinger Environment Variables:

```text
DB_HOST=...
DB_PORT=3306
DB_NAME=...
DB_USER=...
DB_PASSWORD=...
DB_POOL_SIZE=10
DB_SSL=false
```

The application creates its own tables on first start:

- `products`
- `inquiries`
- `rate_limits`

There is deliberately **no orders table**.

## 5. Admin

Set:

```text
ADMIN_EMAIL=admin@lokritijewels.com
ADMIN_PASSWORD_HASH=<bcrypt hash>
JWT_SECRET=<long random secret>
RATE_LIMIT_SECRET=<another long random secret>
```

Generate a bcrypt password hash with:

```bash
node generate-admin-hash.mjs "YOUR-STRONG-ADMIN-PASSWORD"
```

Open the private dashboard directly at:

```text
https://lokritijewels.com/admin
```

It is not linked from public navigation and is marked `noindex,nofollow`.

## 6. Start

Use these Hostinger build/runtime settings when prompted:

- Node.js: **20.x or newer supported version**
- Build command: `npm install --omit=dev`
- Start command: `npm start`
- Entry file (if Hostinger asks): `server.js`

The `start` script in `package.json` runs `node server.js`.

## 7. Domain

Connect your existing GoDaddy domain:

```text
lokritijewels.com
```

Do not transfer the domain unless you specifically want to. Point/connect the domain to the Hostinger application using the DNS/nameserver instructions shown by Hostinger.

Enable HTTPS/SSL and verify both the apex domain and `www` behaviour.

## 8. Images

Editorial photography is bundled under `public/assets/editorial` and `public/assets/home` and is not part of the product catalogue. The eight additional photographs supplied on 19 September 2026 are stored under `public/assets/editorial/user-2026/` and are used only in the homepage editorial display. They are never seeded as products.

Product images uploaded from Admin are:

- rotated using EXIF orientation
- resized to a maximum working size
- converted to WebP
- served with cache headers

For a future multi-instance/high-traffic architecture, set `STORAGE_DRIVER=s3` and configure an S3-compatible object store/CDN. This avoids tying uploaded product media to one application server.

## 9. CDN and scaling

Hostinger's CDN can cache public assets. The application itself is designed to avoid local application state: admin sessions are JWT-based and product/enquiry data is in MySQL.

The Node.js process is therefore much easier to scale horizontally than the earlier SQLite/local-file version. True multi-instance product-media scaling requires shared object storage (`STORAGE_DRIVER=s3`).

This build does **not claim unlimited automatic horizontal autoscaling**. Scaling beyond the capacity of the selected Hostinger service remains a hosting/platform decision.

## 10. SEO

Included:

- unique page titles/descriptions
- canonical URLs
- Open Graph metadata
- Twitter card metadata
- Organization structured data
- WebSite structured data on Home
- dynamic Product structured data on `/products/<slug>`
- dynamic `/sitemap.xml`
- `/robots.txt`
- `/.well-known/security.txt`
- semantic multi-page URLs
- product slugs
- descriptive image alt text
- `noindex,nofollow` on Admin

After launch, verify the domain in Google Search Console and submit:

```text
https://lokritijewels.com/sitemap.xml
```

## 11. Analytics

Optional. Set:

```text
GA4_ID=G-XXXXXXXXXX
META_PIXEL_ID=XXXXXXXXXXXXXXX
```

Leave blank to disable. The public site fetches only these public IDs from `/api/config`; no secret analytics credentials are exposed.

## 12. Enquiry email

The contact form always stores enquiries in MySQL. If SMTP values are configured, the server also emails a notification to `NOTIFY_EMAIL`.

```text
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=Lokriti Jewels <no-reply@lokritijewels.com>
NOTIFY_EMAIL=Lokritijewels@gmail.com
```

## 13. Pre-launch verification

Check all of these after DNS/SSL are live:

- Home loads over HTTPS.
- Hero slideshow displays all four editorial images.
- No duplicate LOKRITI JEWELS by Aditi branding.
- Shop shows the intentional empty state.
- No editorial image appears as a product.
- Search opens and closes correctly.
- Mobile navigation works.
- All client-care pages open.
- Phone link `6376275637` works.
- Email link works.
- Contact form stores an enquiry.
- Admin login works.
- Product creation works.
- Multiple product images upload and become WebP.
- Product editing/deletion works.
- Product detail URL opens and has Product structured data.
- Sitemap lists static pages and any products.
- `/robots.txt` is reachable.
- `/admin` is not linked publicly and is noindex.
- No cart/checkout/payment/order endpoints exist.
- `/api/health` reports database `ok`.

## 14. Backups and operations

Keep Hostinger backups enabled. Also maintain periodic independent exports/backups of the MySQL database and product media.

For serious growth, add:

- external object storage/CDN
- application error monitoring
- uptime monitoring
- staging environment
- deployment through GitHub
- centralized logs
- stronger admin authentication/2FA

## Important

The website is intentionally **view-only + enquiry**. If online purchasing is added in the future, it should be treated as a separate engineering phase rather than re-enabling hidden payment code.

## 15. Important deployment clarification

Uploading the ZIP alone does not make the domain live. Hostinger must deploy it as a **Node.js Web App**, install the npm dependencies, start `server.js`, connect the MySQL database, add the environment variables, and attach `lokritijewels.com` to the app. Hostinger's current Node.js Web App flow supports ZIP upload; after deployment, verify the temporary URL before switching the custom domain/production traffic.

The included static assets are already local to the project. The homepage does not depend on Pinterest, PRERTO, or another website to load its editorial photographs.
