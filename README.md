# LOKRITI JEWELS by Aditi — Premium Catalogue Website

A premium multi-page editorial website for **LOKRITI JEWELS by Aditi**, designed around Indian jewellery, bridal storytelling and a restrained luxury aesthetic.

## Current business mode

This version is intentionally **view-only + enquiry**.

There is no:

- cart
- checkout
- order placement
- payment gateway
- Razorpay
- customer purchase flow
- order database
- order-status system

The website is for discovering the brand, viewing editorial photography, browsing the catalogue when products are later added, and contacting the studio.

## Public pages

- `/` — Home
- `/shop.html` — Shop / catalogue
- `/bridal.html` — Bridal editorial
- `/story.html` — Our Story
- `/faq.html` — FAQ
- `/contact.html` — Contact and enquiry form
- `/shipping.html` — Shipping information
- `/returns.html` — Returns/refund reference
- `/care.html` — Jewellery Care
- `/terms.html` — Terms
- `/privacy.html` — Privacy
- `/products/<slug>` — SEO-friendly product detail pages generated from the private catalogue

## Private studio

`/admin` is a separate, unlinked private dashboard.

It supports:

- add product
- edit product
- delete product
- SKU
- stock quantity
- category
- price
- up to 8 product photos
- image alt text
- SEO title
- SEO description
- client enquiry management

The catalogue starts empty.

**None of the supplied editorial/home photographs are seeded as products.**

## Editorial photography

The permanent editorial images supplied for the website live under:

```text
public/assets/editorial/
public/assets/home/
```

The opening slideshow cycles through the supplied red bridal image, bracelet image, green heritage image and layered bridal image. They are used only as editorial/home imagery.

## Backend

- Node.js 20+
- Express
- MySQL connection pool
- JWT admin authentication
- bcrypt password hashing
- MySQL-backed API rate limiting
- Helmet security headers
- Multer memory uploads
- Sharp image processing
- optional S3-compatible object storage
- optional SMTP enquiry notifications

## Database

Production uses **managed MySQL**, not SQLite.

Tables:

- `products`
- `inquiries`
- `rate_limits`

## Image pipeline

Admin uploads are automatically:

1. orientation-corrected
2. resized
3. converted to WebP
4. stored with long-lived cache headers

Local storage is the default for a single Hostinger app. S3-compatible storage can be enabled for shared product media when horizontal scaling is required.

## SEO

Included:

- unique metadata per page
- canonical URLs
- Open Graph
- Twitter cards
- Organization JSON-LD
- WebSite JSON-LD
- Product JSON-LD for product pages
- clean product slugs
- sitemap
- robots.txt
- security.txt
- descriptive image alt text
- noindex private admin

## Analytics

Optional GA4 and Meta Pixel integration are enabled through environment variables and are disabled when their IDs are blank.

## Contact

Phone: `6376275637`

Email: `Lokritijewels@gmail.com`

Domain: `https://lokritijewels.com`

## Deployment

See `DEPLOYMENT.md` for Hostinger Node.js + MySQL setup.

### Install

```bash
npm install --omit=dev
```

### Run

```bash
npm start
```

### Environment

Copy `.env.example` values into Hostinger Environment Variables.

## Engineering notes

This application is intentionally designed so that the Node.js process does not depend on an application-local SQLite database. Product/enquiry state lives in MySQL, which is a better base for backups and future scaling.

True multi-instance scaling for product media requires shared object storage. Hostinger/CDN can cache public assets, but this package does not claim unlimited automatic horizontal autoscaling from the application itself.

For a larger operation, add staging, Git-based deployment, external media storage, error monitoring, uptime monitoring, 2FA and centralized logs.


## Editorial photography added in the latest revision

Eight additional photographs supplied by the brand are included in `public/assets/editorial/user-2026/`. They are intentionally used only as editorial/display imagery on the homepage. The Shop database starts empty and these photographs are never inserted into the product catalogue.

## Project integration

All public pages are part of the same Node.js application and use the same global CSS/JavaScript, navigation, search, contact API, MySQL database and private Admin API. Product detail URLs are server-rendered by `server.js`. There is no separate disconnected backend folder or payment/order application.
