/**
 * Registers the external PostgreSQL instance in ~/.pgmanager/config.json
 * and seeds demo content (schema + sample rows) into it.
 *
 * Usage:  node scripts/seed-external.js
 */

'use strict';

const { Client } = require('pg');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { randomUUID } = require('crypto');

// ─── Connection details ───────────────────────────────────────────────────────
const HOST     = '127.0.0.1';
const PORT     = 5433;
const USER     = 'postgres';
const PASSWORD = process.env.PG_PASSWORD || 'eg101193';
const DATABASE = 'postgres';

// ─── Config path ─────────────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), '.pgmanager');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) return { instances: [] };
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
  catch { return { instances: [] }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ─── Register instance ────────────────────────────────────────────────────────
function registerInstance() {
  const cfg = loadConfig();
  const existing = cfg.instances.find(i => i.port === PORT && i.superuser === USER);
  if (existing) {
    console.log(`Instance already registered (id=${existing.id}). Skipping.`);
    return existing;
  }

  const instance = {
    id:         randomUUID(),
    name:       'External (5433)',
    port:       PORT,
    dataDir:    '',          // not managed by this app
    superuser:  USER,
    password:   PASSWORD,
    hasPassword: true,
    external:   true,
    createdAt:  new Date().toISOString(),
  };

  cfg.instances.push(instance);
  saveConfig(cfg);
  console.log(`Registered new instance: ${instance.name} (id=${instance.id})`);
  return instance;
}

// ─── Seed content ─────────────────────────────────────────────────────────────
async function seed() {
  const client = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE });
  await client.connect();
  console.log(`Connected to postgresql://${USER}@${HOST}:${PORT}/${DATABASE}`);

  try {
    // Schema
    await client.query(`
      CREATE TABLE IF NOT EXISTS demo_products (
        id          SERIAL PRIMARY KEY,
        name        TEXT    NOT NULL,
        category    TEXT    NOT NULL,
        price_cents INT     NOT NULL,
        in_stock    BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('Table demo_products: ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS demo_orders (
        id           SERIAL PRIMARY KEY,
        product_id   INT  REFERENCES demo_products(id),
        quantity     INT  NOT NULL,
        ordered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('Table demo_orders: ready');

    // Seed rows (idempotent via ON CONFLICT DO NOTHING on name)
    await client.query(`
      ALTER TABLE demo_products ADD COLUMN IF NOT EXISTS name_unique TEXT UNIQUE
    `).catch(() => {/* column may already exist */});

    const products = [
      ['Widget Alpha',  'Widgets',    1999, true],
      ['Widget Beta',   'Widgets',    2499, true],
      ['Gadget Pro',    'Gadgets',    9999, false],
      ['Gadget Lite',   'Gadgets',    4999, true],
      ['Doohickey Plus','Accessories',799,  true],
    ];

    let inserted = 0;
    for (const [name, category, price, inStock] of products) {
      const res = await client.query(
        `INSERT INTO demo_products (name, category, price_cents, in_stock)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM demo_products WHERE name = $1)
         RETURNING id`,
        [name, category, price, inStock],
      );
      if (res.rowCount > 0) inserted++;
    }
    console.log(`demo_products: inserted ${inserted} new rows`);

    // Orders referencing those products
    const prodRes = await client.query(`SELECT id FROM demo_products ORDER BY id LIMIT 3`);
    let ordersInserted = 0;
    for (const row of prodRes.rows) {
      const check = await client.query(
        `SELECT 1 FROM demo_orders WHERE product_id = $1 LIMIT 1`, [row.id],
      );
      if (check.rowCount === 0) {
        await client.query(
          `INSERT INTO demo_orders (product_id, quantity) VALUES ($1, $2)`,
          [row.id, Math.ceil(Math.random() * 10)],
        );
        ordersInserted++;
      }
    }
    console.log(`demo_orders: inserted ${ordersInserted} new rows`);

    // Summary
    const summary = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM demo_products) AS products,
        (SELECT COUNT(*) FROM demo_orders)   AS orders
    `);
    const { products: p, orders: o } = summary.rows[0];
    console.log(`\nDatabase summary: ${p} products, ${o} orders`);

  } finally {
    await client.end();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  registerInstance();
  await seed();
  console.log('\nDone. The instance is now visible in the TUI home screen.');
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
