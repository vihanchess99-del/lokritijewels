import * as Sentry from '@sentry/node';
import express from 'express';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import mysql from 'mysql2/promise';
import sharp from 'sharp';
import nodemailer from 'nodemailer';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import helmet from 'helmet';

dotenv.config();

const NODE_ENV = process.env.NODE_ENV || 'production';
const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(process.env.HOME || path.dirname(ROOT), 'lokriti-data');
const UPLOADS = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const PRIMARY_HOST = (process.env.PRIMARY_HOST || 'lokritijewels.com').toLowerCase();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `https://${PRIMARY_HOST}`).replace(/\/$/, '');
const MAX_PRODUCTS_PER_PAGE = 24;

fs.mkdirSync(UPLOADS, { recursive: true });
sharp.concurrency(Math.max(1, Number(process.env.SHARP_CONCURRENCY || 2)));

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: NODE_ENV, tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.05) });
}

function requireProductionSecrets() {
  if (NODE_ENV !== 'production') return;
  const required = ['JWT_SECRET', 'RATE_LIMIT_SECRET'];
  const missing = required.filter(k => !process.env[k] || process.env[k].length < 32);
  if (missing.length) throw new Error(`Missing/weak production secrets: ${missing.join(', ')}. Set them in Hostinger Environment Variables.`);
}
requireProductionSecrets();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.use(compression({ threshold: 1024 }));

app.use((req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  if (PRIMARY_HOST && host === `www.${PRIMARY_HOST}`) return res.redirect(301, `${PUBLIC_BASE_URL}${req.originalUrl}`);
  next();
});

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      scriptSrc: ["'self'", 'https://www.googletagmanager.com', 'https://connect.facebook.net'],
      connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://analytics.google.com', 'https://*.analytics.google.com', 'https://api.frankfurter.app'],
      formAction: ["'self'"]
    }
  }
}));
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Math.min(20, Math.max(2, Number(process.env.DB_POOL_SIZE || 10))),
  queueLimit: 20,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  maxIdle: Math.min(10, Math.max(2, Number(process.env.DB_POOL_SIZE || 10))),
  idleTimeout: 60000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined
});

let dbReady = false;
let dbLastError = null;
let dbWake = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function executeMigrationFile(file) {
  const raw = await fs.promises.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  const statements = raw.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const sql of statements) await db.query(sql);
}
async function migrate() {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(120) PRIMARY KEY, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [rows] = await db.query(`SELECT version FROM schema_migrations`);
  const done = new Set(rows.map(r => r.version));
  const files = (await fs.promises.readdir(MIGRATIONS_DIR)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    await executeMigrationFile(file);
    await db.query(`INSERT INTO schema_migrations(version,applied_at) VALUES(?,NOW())`, [file]);
  }
}
async function dbLoop() {
  let delay = 1000;
  while (!dbReady) {
    try {
      await migrate();
      await db.query('SELECT 1');
      dbReady = true;
      dbLastError = null;
      if (dbWake) { dbWake(); dbWake = null; }
      console.log('[db] ready');
      break;
    } catch (err) {
      dbLastError = err;
      console.error(`[db] unavailable; retrying in ${Math.round(delay / 1000)}s`, err.message);
      await sleep(delay);
      delay = Math.min(delay * 2, 15000);
    }
  }
}
dbLoop();

async function ensureDb(timeoutMs = 5000) {
  if (dbReady) return;
  await Promise.race([
    new Promise(resolve => { dbWake = resolve; }),
    sleep(timeoutMs)
  ]);
  if (!dbReady) throw Object.assign(new Error('Database temporarily unavailable.'), { code: 'DB_UNAVAILABLE' });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 8, fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype))
});

function nowSql() { return new Date(); }
function safeText(v, max = 2000) { return String(v ?? '').trim().slice(0, max); }
function parseJson(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch { return []; } }
function slugify(v) { return safeText(v, 180).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'piece'; }
function clientIp(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }
function rateKey(req, scope) { return crypto.createHmac('sha256', process.env.RATE_LIMIT_SECRET).update(`${scope}:${clientIp(req)}`).digest('hex'); }
function publicBase(req) { return PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`; }
function escapeHtml(s) { return String(s).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }

const storageDriver = process.env.STORAGE_DRIVER || 'local';
let s3 = null;
if (storageDriver === 's3') {
  s3 = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
  });
}

async function saveImage(file) {
  const id = crypto.randomUUID();
  const buffer = await sharp(file.buffer).rotate().resize({ width: 1800, height: 2200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84, effort: 5 }).toBuffer();
  const key = `products/${id}.webp`;
  if (storageDriver === 's3') {
    if (!s3 || !process.env.S3_BUCKET || !process.env.S3_PUBLIC_BASE_URL) throw new Error('S3 storage is not fully configured.');
    await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: buffer, ContentType: 'image/webp', CacheControl: 'public,max-age=31536000,immutable' }));
    return `${process.env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
  }
  const filePath = path.join(UPLOADS, `${id}.webp`);
  await fs.promises.writeFile(filePath, buffer);
  return `/uploads/${id}.webp`;
}
async function deleteImage(url) {
  if (!url) return;
  if (storageDriver === 's3' && process.env.S3_PUBLIC_BASE_URL) {
    const base = process.env.S3_PUBLIC_BASE_URL.replace(/\/$/, '');
    if (url.startsWith(base + '/')) {
      const key = url.slice(base.length + 1);
      try { await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })); } catch {}
    }
    return;
  }
  if (url.startsWith('/uploads/')) {
    try { await fs.promises.unlink(path.join(UPLOADS, path.basename(url))); } catch {}
  }
}

function rateLimit({ scope, limit, windowMs }) {
  return async (req, res, next) => {
    try {
      await ensureDb();
      const key = rateKey(req, scope);
      const start = Math.floor(Date.now() / windowMs) * windowMs;
      await db.query(`INSERT INTO rate_limits(bucket_key,window_start,hit_count,updated_at) VALUES(?,?,1,NOW()) ON DUPLICATE KEY UPDATE hit_count=IF(window_start<>VALUES(window_start),1,hit_count+1),window_start=VALUES(window_start),updated_at=NOW()`, [key, start]);
      const [rows] = await db.query(`SELECT hit_count FROM rate_limits WHERE bucket_key=? LIMIT 1`, [key]);
      if (Number(rows[0]?.hit_count || 0) > limit) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
      next();
    } catch (e) {
      return res.status(e.code === 'DB_UNAVAILABLE' ? 503 : 500).json({ error: 'Protection service temporarily unavailable. Please try again shortly.' });
    }
  };
}
const rateCleanup = setInterval(() => { if (dbReady) db.query(`DELETE FROM rate_limits WHERE updated_at < (NOW() - INTERVAL 2 HOUR)`).catch(() => {}); }, 10 * 60 * 1000);
rateCleanup.unref();

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (!token) throw new Error();
    req.admin = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'lokriti-admin' });
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}

async function fetchProducts({ page = 1, limit = MAX_PRODUCTS_PER_PAGE, category = '', q = '', includeDeleted = false } = {}) {
  page = Math.max(1, Number(page) || 1);
  limit = Math.min(MAX_PRODUCTS_PER_PAGE, Math.max(1, Number(limit) || MAX_PRODUCTS_PER_PAGE));
  const offset = (page - 1) * limit;
  const where = [includeDeleted ? '1=1' : 'deleted_at IS NULL'];
  const params = [];
  if (category && category !== 'All') { where.push('category=?'); params.push(category); }
  const cleanQ = q.replace(/[+\-@><()~*" ]+/g, ' ').trim();
  if (cleanQ) { where.push(`MATCH(name,category,description) AGAINST(? IN BOOLEAN MODE)`); params.push(`${cleanQ}*`); }
  const clause = where.join(' AND ');
  let countRows;
  try {
    [countRows] = await db.query(`SELECT COUNT(*) AS total FROM products WHERE ${clause}`, params);
  } catch (err) {
    if (cleanQ && err.code === 'ER_PARSE_ERROR') {
      const fallbackWhere = [includeDeleted ? '1=1' : 'deleted_at IS NULL'];
      const fallbackParams = [];
      if (category && category !== 'All') { fallbackWhere.push('category=?'); fallbackParams.push(category); }
      fallbackWhere.push('(name LIKE ? OR category LIKE ? OR description LIKE ?)');
      const like = `%${q}%`; fallbackParams.push(like, like, like);
      [countRows] = await db.query(`SELECT COUNT(*) AS total FROM products WHERE ${fallbackWhere.join(' AND ')}`, fallbackParams);
      const [rows] = await db.query(`SELECT id,slug,sku,name,category,price,stock,description,images,image_alts,badge,seo_title,seo_description,created_at,updated_at FROM products WHERE ${fallbackWhere.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...fallbackParams, limit, offset]);
      return { items: normalizeProducts(rows), total: Number(countRows[0].total), page, limit, pages: Math.ceil(Number(countRows[0].total) / limit) };
    }
    throw err;
  }
  const [rows] = await db.query(`SELECT id,slug,sku,name,category,price,stock,description,images,image_alts,badge,seo_title,seo_description,created_at,updated_at FROM products WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: normalizeProducts(rows), total: Number(countRows[0].total), page, limit, pages: Math.ceil(Number(countRows[0].total) / limit) };
}
function normalizeProducts(rows) { return rows.map(p => ({ ...p, price: Number(p.price), images: parseJson(p.images), imageAlts: parseJson(p.image_alts) })); }

async function uniqueSlug(name, existingId = null) {
  const base = slugify(name); let slug = base;
  for (let i = 2; i < 100; i++) {
    const [rows] = await db.query(`SELECT id FROM products WHERE slug=? ${existingId ? 'AND id<>?' : ''} LIMIT 1`, existingId ? [slug, existingId] : [slug]);
    if (!rows.length) return slug; slug = `${base}-${i}`;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function asset(name) { return `/assets/${name}`; }
const HERO_IMAGE = `${PUBLIC_BASE_URL}/assets/editorial/hero-red-emerald.05495fb948.jpg`;

function header(active = '') {
  return `<div class="announcement">Private viewing · Editorial jewellery · Client enquiries welcome</div><header class="site-header"><div class="nav"><button class="icon-btn mobile-toggle" aria-label="Open menu" aria-expanded="false">☰</button><a class="brand" href="/" aria-label="LOKRITI JEWELS by Aditi home"><strong>LOKRITI JEWELS</strong><small>by Aditi</small></a><nav class="nav-links"><a class="${active==='home'?'active':''}" href="/">Home</a><a class="${active==='shop'?'active':''}" href="/shop.html">Shop</a><a class="${active==='bridal'?'active':''}" href="/bridal.html">Bridal</a><a class="${active==='story'?'active':''}" href="/story.html">Our Story</a><a class="${active==='faq'?'active':''}" href="/faq.html">FAQ</a><a class="${active==='contact'?'active':''}" href="/contact.html">Contact</a></nav><div class="nav-actions"><button class="icon-btn search-trigger" aria-label="Search">⌕</button><a class="phone-nav" href="tel:6376275637" aria-label="Call 6376275637">6376275637</a></div></div><nav class="mobile-nav"><a href="/">Home</a><a href="/shop.html">Shop</a><a href="/bridal.html">Bridal</a><a href="/story.html">Our Story</a><a href="/faq.html">FAQ</a><a href="/contact.html">Contact</a><a href="/shipping.html">Shipping</a><a href="/returns.html">Returns</a><a href="/care.html">Jewellery Care</a></nav></header>`;
}
function footer() {
  return `<footer class="footer"><div class="footer-grid"><div><h3>LOKRITI JEWELS</h3><p>Jewellery chosen for the everyday, the celebrations, and everything in between.</p><p style="margin-top:18px">By Aditi · India</p></div><div><h3>Explore</h3><div class="footer-links"><a href="/shop.html">Shop</a><a href="/bridal.html">Bridal</a><a href="/story.html">Our Story</a><a href="/faq.html">FAQ</a></div></div><div><h3>Client Care</h3><div class="footer-links"><a href="/shipping.html">Shipping</a><a href="/returns.html">Returns &amp; Refunds</a><a href="/care.html">Jewellery Care</a><a href="/terms.html">Terms &amp; Conditions</a><a href="/privacy.html">Privacy</a></div></div><div><h3>Contact</h3><div class="footer-links"><a href="tel:6376275637">6376275637</a><a href="mailto:Lokritijewels@gmail.com">Lokritijewels@gmail.com</a><a href="${PUBLIC_BASE_URL}">${PRIMARY_HOST}</a><a href="https://wa.me/916376275637">WhatsApp</a></div></div></div><div class="footer-bottom"><span>© ${new Date().getFullYear()} LOKRITI JEWELS by Aditi</span><span>Crafted with restraint · Rooted in India</span></div></footer>`;
}
function searchPanel() { return `<div class="search-panel"><button class="close" aria-label="Close search" style="position:absolute;right:30px;top:20px">×</button><div class="eyebrow" style="color:var(--maroon)">Search LOKRITI</div><input aria-label="Search the collection" placeholder="Search the collection…"/><div class="search-results"></div></div><div class="toast" aria-live="polite"></div>`; }
function productCard(p) {
  const image = p.images?.[0] || '/assets/product-placeholder.svg';
  const alt = p.imageAlts?.[0] || `${p.name} — ${p.category}`;
  return `<article class="product-card"><a class="product-link" href="/products/${encodeURIComponent(p.slug)}"><img src="${escapeAttr(image)}" alt="${escapeAttr(alt)}" width="900" height="1125" loading="lazy" decoding="async"><div class="pcopy"><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.category)}</p><div class="price">₹${Number(p.price).toLocaleString('en-IN')}</div><span class="text-link">View piece ↗</span></div></a></article>`;
}
function emptyProducts() { return `<div class="empty-products"><div class="eyebrow" style="color:var(--maroon)">The collection is being curated</div><h2>Coming soon.</h2><p style="max-width:520px;margin:0 auto 24px;color:var(--muted)">This space is intentionally empty for now. New pieces will appear here as the collection is curated. For purchase enquiries, please call <a href="tel:6376275637" class="text-link">6376275637</a>.</p><a class="btn" href="/contact.html">Enquire with us</a></div>`; }

app.get('/api/health', async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, service: 'LOKRITI JEWELS by Aditi', database: 'starting', error: dbLastError?.message || 'Database not ready' });
  try { await db.query('SELECT 1'); res.json({ ok: true, service: 'LOKRITI JEWELS by Aditi', database: 'ok', mode: 'catalogue-only' }); }
  catch { res.status(503).json({ ok: false, service: 'LOKRITI JEWELS by Aditi', database: 'error' }); }
});
app.get('/api/config', (req,res)=>res.json({ ga4Id: process.env.GA4_ID || '', metaPixelId: process.env.META_PIXEL_ID || '', siteUrl: PUBLIC_BASE_URL }));
app.get('/api/rates', async (req,res) => {
  const targets = 'USD,GBP,EUR,AED,CAD,AUD';
  try {
    const r = await fetch(`https://api.frankfurter.app/latest?from=INR&to=${targets}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('rate service failed');
    const j = await r.json();
    res.set('Cache-Control', 'public,max-age=21600,stale-while-revalidate=86400').json({ base: 'INR', rates: { INR: 1, ...(j.rates || {}) }, source: 'Frankfurter/ECB', fetchedAt: new Date().toISOString() });
  } catch {
    res.status(503).json({ error: 'Live currency rates are temporarily unavailable.' });
  }
});
app.get('/api/products', async (req,res,next) => {
  try {
    await ensureDb();
    const result = await fetchProducts({ page: req.query.page || 1, limit: req.query.limit || MAX_PRODUCTS_PER_PAGE, category: safeText(req.query.category,80), q: safeText(req.query.q,100) });
    res.set('Cache-Control', 'public,max-age=30,stale-while-revalidate=120').json(result);
  } catch (e) { next(e); }
});
app.get('/api/products/:slug', async (req, res, next) => {
  try {
    await ensureDb();
    const [rows] = await db.query(`SELECT id,slug,sku,name,category,price,stock,description,images,image_alts,badge,seo_title,seo_description,created_at,updated_at FROM products WHERE slug=? AND deleted_at IS NULL LIMIT 1`, [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(normalizeProducts(rows)[0]);
  } catch (e) { next(e); }
});

app.post('/api/contact', rateLimit({ scope: 'contact', limit: 5, windowMs: 10 * 60 * 1000 }), async (req, res, next) => {
  try {
    const name = safeText(req.body.name, 120), email = safeText(req.body.email, 180), phone = safeText(req.body.phone, 40), message = safeText(req.body.message, 3000);
    const honeypot = safeText(req.body.website, 120);
    const started = Number(req.body.form_started_at || 0);
    if (honeypot || (started && Date.now() - started < 1200)) return res.json({ ok: true });
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message) return res.status(400).json({ error: 'Please provide a valid name, email and message.' });
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO inquiries(id,name,email,phone,message,created_at,status) VALUES(?,?,?,?,?,?,'new')`, [id, name, email, phone, message, nowSql()]);
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.NOTIFY_EMAIL) {
      try {
        const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000 });
        await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: process.env.NOTIFY_EMAIL, replyTo: email, subject: `New LOKRITI client enquiry from ${name}`, text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n\n${message}` });
      } catch (err) { console.error('[smtp] enquiry notification failed', err.message); }
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/admin/login', rateLimit({ scope: 'admin-login', limit: 8, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD_HASH || !process.env.JWT_SECRET) return res.status(503).json({ error: 'Admin authentication is not configured.' });
  const submittedEmail = safeText(req.body.email, 180).toLowerCase();
  const configuredEmail = String(process.env.ADMIN_EMAIL).toLowerCase();
  const a = Buffer.from(submittedEmail), b = Buffer.from(configuredEmail);
  const emailMatch = a.length === b.length && crypto.timingSafeEqual(a, b);
  const passwordMatch = await bcrypt.compare(String(req.body.password || ''), process.env.ADMIN_PASSWORD_HASH);
  if (!emailMatch || !passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ ok: true, token: jwt.sign({ admin: true, email: configuredEmail }, process.env.JWT_SECRET, { expiresIn: '8h', issuer: 'lokriti-admin' }) });
});

app.get('/api/admin/products', auth, async (req,res,next) => { try { await ensureDb(); const [rows] = await db.query(`SELECT id,slug,sku,name,category,price,stock,description,images,image_alts,badge,seo_title,seo_description,created_at,updated_at FROM products WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500`); res.json(normalizeProducts(rows)); } catch(e) { next(e); } });
app.get('/api/admin/inquiries', auth, async (req, res, next) => { try { await ensureDb(); const [rows] = await db.query(`SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 200`); res.json(rows); } catch(e) { next(e); } });
app.patch('/api/admin/inquiries/:id', auth, async (req, res, next) => { try { await ensureDb(); const status = String(req.body.status || ''); if (!['new','read','closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' }); await db.query(`UPDATE inquiries SET status=? WHERE id=?`, [status, req.params.id]); res.json({ ok: true }); } catch(e) { next(e); } });

app.post('/api/admin/products', auth, upload.array('images', 8), async (req, res, next) => {
  const files = req.files || [], saved = [];
  try {
    await ensureDb();
    const name = safeText(req.body.name, 180), category = safeText(req.body.category, 80), sku = safeText(req.body.sku, 80) || null;
    const price = Number(req.body.price), stock = Math.max(0, Math.floor(Number(req.body.stock || 0)));
    if (!name || !category || !Number.isFinite(price) || price < 0) throw new Error('Enter a valid product name, category and price.');
    if (!files.length) throw new Error('Add at least one product photo.');
    if (sku) { const [dupe] = await db.query(`SELECT id FROM products WHERE sku=? AND deleted_at IS NULL LIMIT 1`, [sku]); if (dupe.length) throw new Error('That SKU is already in use.'); }
    const images = [], imageAlts = [];
    for (const file of files) { const url = await saveImage(file); saved.push(url); images.push(url); imageAlts.push(safeText(req.body.alt_text || `${name} — ${category}`, 180)); }
    const id = crypto.randomUUID(), slug = await uniqueSlug(name), now = nowSql();
    await db.query(`INSERT INTO products(id,slug,sku,name,category,price,stock,description,images,image_alts,badge,seo_title,seo_description,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`, [id, slug, sku, name, category, price, stock, safeText(req.body.description), JSON.stringify(images), JSON.stringify(imageAlts), safeText(req.body.badge, 80) || null, safeText(req.body.seo_title, 255) || null, safeText(req.body.seo_description, 320) || null, now, now]);
    res.json({ ok: true, id, slug });
  } catch (e) { for (const url of saved) await deleteImage(url); next(e); }
});

app.put('/api/admin/products/:id', auth, upload.array('images', 8), async (req, res, next) => {
  const saved = [];
  try {
    await ensureDb();
    const [found] = await db.query(`SELECT * FROM products WHERE id=? AND deleted_at IS NULL LIMIT 1`, [req.params.id]);
    if (!found.length) return res.status(404).json({ error: 'Product not found' });
    const old = found[0], files = req.files || [];
    const name = safeText(req.body.name, 180), category = safeText(req.body.category, 80), sku = safeText(req.body.sku, 80) || null;
    const price = Number(req.body.price), stock = Math.max(0, Math.floor(Number(req.body.stock || 0)));
    if (!name || !category || !Number.isFinite(price) || price < 0) throw new Error('Enter a valid product name, category and price.');
    if (sku) { const [dupe] = await db.query(`SELECT id FROM products WHERE sku=? AND id<>? AND deleted_at IS NULL LIMIT 1`, [sku, req.params.id]); if (dupe.length) throw new Error('That SKU is already in use.'); }
    const slug = await uniqueSlug(name, req.params.id);
    let images = parseJson(old.images), imageAlts = parseJson(old.image_alts);
    if (files.length) {
      images = []; imageAlts = [];
      for (const file of files) { const url = await saveImage(file); saved.push(url); images.push(url); imageAlts.push(safeText(req.body.alt_text || `${name} — ${category}`, 180)); }
    }
    await db.query(`UPDATE products SET slug=?,sku=?,name=?,category=?,price=?,stock=?,description=?,images=?,image_alts=?,badge=?,seo_title=?,seo_description=?,updated_at=? WHERE id=? AND deleted_at IS NULL`, [slug, sku, name, category, price, stock, safeText(req.body.description), JSON.stringify(images), JSON.stringify(imageAlts), safeText(req.body.badge, 80) || null, safeText(req.body.seo_title, 255) || null, safeText(req.body.seo_description, 320) || null, nowSql(), req.params.id]);
    if (files.length) for (const oldUrl of parseJson(old.images)) await deleteImage(oldUrl);
    res.json({ ok: true, slug });
  } catch (e) { for (const url of saved) await deleteImage(url); next(e); }
});

app.delete('/api/admin/products/:id', auth, async (req, res, next) => {
  try { await ensureDb(); const [rows] = await db.query(`SELECT id FROM products WHERE id=? AND deleted_at IS NULL LIMIT 1`, [req.params.id]); if (!rows.length) return res.status(404).json({ error: 'Product not found' }); await db.query(`UPDATE products SET deleted_at=NOW(),updated_at=NOW() WHERE id=?`, [req.params.id]); res.json({ ok: true }); } catch(e) { next(e); }
});
app.post('/api/admin/products/:id/restore', auth, async (req,res,next) => { try { await ensureDb(); const [rows] = await db.query(`SELECT id FROM products WHERE id=? AND deleted_at IS NOT NULL LIMIT 1`, [req.params.id]); if (!rows.length) return res.status(404).json({error:'Deleted product not found'}); await db.query(`UPDATE products SET deleted_at=NULL,updated_at=NOW() WHERE id=?`, [req.params.id]); res.json({ok:true}); } catch(e) { next(e); } });

app.get('/products/:slug', async (req, res, next) => {
  try {
    await ensureDb();
    const [rows] = await db.query(`SELECT * FROM products WHERE slug=? AND deleted_at IS NULL LIMIT 1`, [req.params.slug]);
    if (!rows.length) return next();
    const p = rows[0], images = parseJson(p.images), alts = parseJson(p.image_alts), base = publicBase(req);
    const title = safeText(p.seo_title, 255) || `${p.name} | LOKRITI JEWELS by Aditi`;
    const desc = safeText(p.seo_description, 320) || safeText(p.description, 320) || `${p.name} — ${p.category} from LOKRITI JEWELS by Aditi.`;
    const image = images[0] ? (images[0].startsWith('http') ? images[0] : base + images[0]) : `${base}/assets/product-placeholder.svg`;
    const canonical = `${base}/products/${encodeURIComponent(p.slug)}`;
    const schema = JSON.stringify({ '@context':'https://schema.org', '@type':'Product', name:p.name, description:desc, image:images.map(x=>x.startsWith('http')?x:base+x), sku:p.sku||undefined, brand:{'@type':'Brand',name:'LOKRITI JEWELS by Aditi'}, category:p.category, additionalProperty:[{'@type':'PropertyValue',name:'Purchase method',value:'Enquiry by phone or contact form'}] });
    const cards = images.map((x,i)=>`<img src="${escapeAttr(x)}" alt="${escapeAttr(alts[i] || `${p.name} — ${p.category}`)}" width="900" height="1125" ${i?'loading="lazy"':''} decoding="async">`).join('');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#641c2b"><meta name="description" content="${escapeAttr(desc)}"><link rel="canonical" href="${canonical}"><meta property="og:type" content="product"><meta property="og:title" content="${escapeAttr(title)}"><meta property="og:description" content="${escapeAttr(desc)}"><meta property="og:image" content="${escapeAttr(image)}"><meta property="og:url" content="${canonical}"><meta property="og:site_name" content="LOKRITI JEWELS by Aditi"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escapeAttr(image)}"><title>${escapeHtml(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/site.7554679c7092.css"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,400;6..96,500;6..96,600&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"><script type="application/ld+json">${schema}</script></head><body>${header('shop')}<main><section class="page-hero"><div class="inner"><div class="eyebrow">${escapeHtml(p.category)}</div><h1>${escapeHtml(p.name)}</h1><p>${escapeHtml(desc)}</p></div></section><section class="section product-detail"><div class="product-detail-gallery">${cards}</div><div class="product-detail-copy"><div class="eyebrow" style="color:var(--maroon)">${escapeHtml(p.category)}</div><h2>${escapeHtml(p.name)}</h2><p class="price">₹${Number(p.price).toLocaleString('en-IN')}</p><p>${escapeHtml(p.description || 'A considered piece from the LOKRITI JEWELS collection.')}</p><p class="availability">Please contact 6376275637 for purchase enquiries, styling and availability.</p><div class="btn-row"><button class="btn" id="wishlistDetail" type="button" data-product-id="${escapeAttr(p.id)}">♡ Save to wishlist</button><a class="btn" href="/contact.html">Enquire about this piece</a><a class="btn ghost dark" href="/shop.html">Back to collection</a></div></div></section></main>${footer()}${searchPanel()}<script>document.addEventListener('DOMContentLoaded',()=>{const b=document.getElementById('wishlistDetail');if(!b)return;const k='lokriti_wishlist_v1';let w=[];try{w=JSON.parse(localStorage.getItem(k)||'[]')}catch{};const id=b.dataset.productId;const sync=()=>{const saved=w.includes(id);b.textContent=saved?'♥ Saved to wishlist':'♡ Save to wishlist';b.classList.toggle('saved',saved)};b.addEventListener('click',()=>{const i=w.indexOf(id);if(i>=0)w.splice(i,1);else w.push(id);localStorage.setItem(k,JSON.stringify(w));sync()});sync()});</script><script src="/assets/site.f3abec54bb7d.js" defer></script></body></html>`);
  } catch(e) { next(e); }
});

app.get('/shop', (req,res)=>res.redirect(301,'/shop.html'));
app.get('/shop.html', async (req,res,next)=>{
  try {
    const file = path.join(PUBLIC,'shop.html');
    let html = await fs.promises.readFile(file,'utf8');
    let products = [];
    if (dbReady) {
      try { products = (await fetchProducts({page:1,limit:MAX_PRODUCTS_PER_PAGE,category:safeText(req.query.category,80),q:safeText(req.query.q,100)})).items; } catch {}
    }
    const cards = products.length ? products.map(productCard).join('') : emptyProducts();
    html = html.replace('<!--PRODUCTS_SSR-->', cards);
    res.set('Cache-Control','no-cache').type('html').send(html);
  } catch(e) { next(e); }
});

app.get('/robots.txt', (req,res)=>res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${PUBLIC_BASE_URL}/sitemap.xml\n`));
app.get('/sitemap.xml', async (req,res,next)=>{
  try {
    await ensureDb();
    const staticPages = ['/', '/shop.html','/bridal.html','/story.html','/faq.html','/contact.html','/shipping.html','/returns.html','/care.html','/terms.html','/privacy.html'];
    const lastmod = new Date().toISOString().slice(0,10);
    const [rows] = await db.query(`SELECT slug,updated_at FROM products WHERE deleted_at IS NULL ORDER BY updated_at DESC`);
    const urls = staticPages.map(u=>`<url><loc>${PUBLIC_BASE_URL}${u}</loc><lastmod>${lastmod}</lastmod></url>`).join('') + rows.map(p=>`<url><loc>${PUBLIC_BASE_URL}/products/${encodeURIComponent(p.slug)}</loc><lastmod>${new Date(p.updated_at).toISOString()}</lastmod></url>`).join('');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  } catch(e) { next(e); }
});
app.get('/image-sitemap.xml', async (req,res,next)=>{
  try {
    await ensureDb();
    const imageFiles=[];
    async function walk(dir, prefix='') { for (const entry of await fs.promises.readdir(dir,{withFileTypes:true})) { const full=path.join(dir,entry.name); const rel=prefix?`${prefix}/${entry.name}`:entry.name; if(entry.isDirectory()) await walk(full,rel); else if(/\.(jpe?g|png|webp|svg)$/i.test(entry.name)) imageFiles.push(`${PUBLIC_BASE_URL}/${rel.replace(/\\/g,'/')}`); } }
    await walk(path.join(PUBLIC,'assets'),'assets');
    const [rows]=await db.query(`SELECT images FROM products WHERE deleted_at IS NULL`);
    for(const row of rows) for(const img of parseJson(row.images)) imageFiles.push(img.startsWith('http')?img:PUBLIC_BASE_URL+img);
    const unique=[...new Set(imageFiles)];
    const items=unique.map(u=>`<url><loc>${PUBLIC_BASE_URL}/</loc><image:image><image:loc>${escapeHtml(u)}</image:loc></image:image></url>`).join('');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${items}</urlset>`);
  } catch(e) { next(e); }
});
app.get('/security.txt', (req,res)=>res.type('text/plain').send(`Contact: mailto:Lokritijewels@gmail.com\nPreferred-Languages: en\nCanonical: ${PUBLIC_BASE_URL}/.well-known/security.txt\n`));
app.get('/.well-known/security.txt', (req,res)=>res.type('text/plain').send(`Contact: mailto:Lokritijewels@gmail.com\nPreferred-Languages: en\nCanonical: ${PUBLIC_BASE_URL}/.well-known/security.txt\n`));

app.use('/uploads', express.static(UPLOADS, { fallthrough: false, maxAge: '365d', immutable: true }));
app.use(express.static(PUBLIC, { index:'index.html', setHeaders(res,filePath){ if(/\.html$/i.test(filePath)) res.setHeader('Cache-Control','no-cache'); else if(/\.(css|js|svg|webp|jpe?g|png|woff2?)$/i.test(filePath)) { res.setHeader('Cache-Control','public,max-age=31536000,immutable'); } } }));
app.get(['/admin','/admin/'], (req,res)=>res.sendFile(path.join(ROOT,'admin','index.html')));
app.get('*',(req,res)=>{ if(req.path.startsWith('/api/')) return res.status(404).json({error:'Not found'}); res.status(404).sendFile(path.join(PUBLIC,'404.html')); });

app.use((err,req,res,next)=>{ console.error('[error]',err); if(process.env.SENTRY_DSN) Sentry.captureException(err); if(res.headersSent) return next(err); const status=err.code==='DB_UNAVAILABLE'?503:500; res.status(status).json({error:status===503?'Service temporarily unavailable. Please try again shortly.':'Something went wrong. Please try again.'}); });

const server = app.listen(PORT, ()=>console.log(`LOKRITI JEWELS by Aditi running on port ${PORT}`));
let shuttingDown=false;
async function shutdown(signal){ if(shuttingDown)return; shuttingDown=true; console.log(`[server] ${signal}; shutting down`); clearInterval(rateCleanup); server.close(async()=>{ try{await db.end();}catch{} process.exit(0); }); setTimeout(()=>process.exit(1),10000).unref(); }
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('unhandledRejection',err=>{ console.error('[unhandledRejection]',err); if(process.env.SENTRY_DSN)Sentry.captureException(err); });
process.on('uncaughtException',err=>{ console.error('[uncaughtException]',err); if(process.env.SENTRY_DSN)Sentry.captureException(err); });
