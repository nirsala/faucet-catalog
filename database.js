const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'catalog.db');
const BACKUP_DIR = path.join(__dirname, 'backups');

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA foreign_keys = ON");

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'dealer',
    store_slug TEXT UNIQUE,
    logo_path TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    image_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    category_id TEXT NOT NULL,
    base_price REAL NOT NULL,
    image_path TEXT,
    sku TEXT,
    finish TEXT,
    display_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    image_path TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS dealer_prices (
    id TEXT PRIMARY KEY,
    dealer_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    price REAL NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (dealer_id) REFERENCES users(id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    UNIQUE(dealer_id, product_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS dealer_product_order (
    id TEXT PRIMARY KEY,
    dealer_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    FOREIGN KEY (dealer_id) REFERENCES users(id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    UNIQUE(dealer_id, product_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS product_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    dealer_id TEXT,
    clicked_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cart_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealer_id TEXT,
    product_ids TEXT,
    product_count INTEGER DEFAULT 0,
    total_price REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (dealer_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    dealer_id TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (dealer_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    display_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Add columns if they don't exist (migrations)
  try { db.run('ALTER TABLE users ADD COLUMN logo_path TEXT'); } catch {}
  try { db.run('ALTER TABLE products ADD COLUMN finish TEXT'); } catch {}
  try { db.run('ALTER TABLE users ADD COLUMN price_color TEXT'); } catch {}
  try { db.run('ALTER TABLE notifications ADD COLUMN details TEXT'); } catch {}

  seedTags();
  seedData();
  saveDb();

  // Setup daily backup
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  scheduleBackup();

  return db;
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function createBackup() {
  const data = db.export();
  const buffer = Buffer.from(data);
  const now = new Date();
  const filename = `backup-${now.toISOString().replace(/[:.]/g, '-')}.db`;
  fs.writeFileSync(path.join(BACKUP_DIR, filename), buffer);

  // Keep only last 7 backups
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
    .sort().reverse();
  for (const old of files.slice(7)) {
    fs.unlinkSync(path.join(BACKUP_DIR, old));
  }
  console.log(`Backup created: ${filename}`);
}

function scheduleBackup() {
  // Run backup every 24 hours
  setInterval(createBackup, 24 * 60 * 60 * 1000);
  // Also create one on startup
  createBackup();
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function runNoSave(sql, params = []) {
  db.run(sql, params);
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function seedTags() {
  const existing = get('SELECT COUNT(*) as c FROM tags');
  if (existing && existing.c > 0) return;
  const tags = ['שחור מט', 'כרום', 'נירוסטה', 'שחור מט/זהב', 'זהב', 'ברונזה'];
  for (let i = 0; i < tags.length; i++) {
    db.run('INSERT INTO tags (id, name, display_order) VALUES (?, ?, ?)', [uuidv4(), tags[i], i]);
  }
  console.log('Tags seeded');
}

function seedData() {
  const admin = get('SELECT id FROM users WHERE role = ?', ['admin']);
  if (admin) return;

  const adminId = uuidv4();
  const hashedPassword = bcrypt.hashSync('admin123', 10);
  db.run('INSERT INTO users (id, username, password, display_name, role) VALUES (?, ?, ?, ?, ?)',
    [adminId, 'admin', hashedPassword, 'מנהל מערכת', 'admin']);

  const categories = [
    { id: uuidv4(), name: 'ברזי מטבח', order: 1 },
    { id: uuidv4(), name: 'ברזי אמבטיה', order: 2 },
    { id: uuidv4(), name: 'ברזי כיור', order: 3 },
    { id: uuidv4(), name: 'ברזי מקלחת', order: 4 },
    { id: uuidv4(), name: 'ראשי מקלחת', order: 5 },
    { id: uuidv4(), name: 'אביזרי אמבטיה', order: 6 },
  ];

  for (const cat of categories) {
    db.run('INSERT INTO categories (id, name, display_order) VALUES (?, ?, ?)', [cat.id, cat.name, cat.order]);
  }

  const finishes = ['שחור מט', 'כרום', 'נירוסטה', 'כרום', 'שחור מט/זהב', 'זהב', 'כרום', 'שחור מט', 'ברונזה', 'שחור מט', 'כרום', 'כרום', 'כרום', 'שחור מט', 'כרום', 'שחור מט', 'שחור מט', 'כרום', 'כרום', 'שחור מט', 'זהב', 'כרום', 'שחור מט'];

  const products = [
    { name: 'ברז מטבח נשלף שחור מט', desc: 'ברז מטבח מעוצב עם ראש נשלף, גימור שחור מט. מתאים למטבחים מודרניים.', cat: 0, price: 890, sku: 'KF-001' },
    { name: 'ברז מטבח נשלף נירוסטה', desc: 'ברז מטבח נשלף מנירוסטה 304, עמיד ואיכותי. שני מצבי זרם.', cat: 0, price: 750, sku: 'KF-002' },
    { name: 'ברז מטבח גבוה קשת כרום', desc: 'ברז מטבח בעל קשת גבוהה, גימור כרום מבריק. סיבוב 360 מעלות.', cat: 0, price: 650, sku: 'KF-003' },
    { name: 'ברז מטבח עם מסנן מים', desc: 'ברז מטבח כפול עם מערכת סינון מים מובנית. חיבור ישיר למסנן.', cat: 0, price: 1200, sku: 'KF-004' },
    { name: 'ברז מטבח קיר שחור זהב', desc: 'ברז מטבח להתקנה על הקיר, שילוב שחור וזהב יוקרתי.', cat: 0, price: 1100, sku: 'KF-005' },
    { name: 'ברז אמבטיה פרח זהב', desc: 'ברז אמבטיה מעוצב בסגנון קלאסי, גימור זהב מוברש.', cat: 1, price: 980, sku: 'BF-001' },
    { name: 'ברז אמבטיה מפל כרום', desc: 'ברז אמבטיה עם זרם מפל, גימור כרום. עיצוב מינימליסטי.', cat: 1, price: 850, sku: 'BF-002' },
    { name: 'ברז אמבטיה קיר שחור', desc: 'ברז אמבטיה להתקנה על הקיר, גימור שחור מט. כולל מזלף.', cat: 1, price: 1150, sku: 'BF-003' },
    { name: 'ברז אמבטיה רטרו ברונזה', desc: 'ברז אמבטיה בסגנון רטרו, גימור ברונזה עתיק. ידיות צלב.', cat: 1, price: 1050, sku: 'BF-004' },
    { name: 'ברז כיור מונו שחור מט', desc: 'ברז כיור חור אחד, גימור שחור מט. קו נקי ומודרני.', cat: 2, price: 450, sku: 'SF-001' },
    { name: 'ברז כיור גבוה כרום', desc: 'ברז כיור גבוה לכיורי הנחה, גימור כרום מבריק.', cat: 2, price: 520, sku: 'SF-002' },
    { name: 'ברז כיור סנסור אוטומטי', desc: 'ברז כיור עם חיישן אינפרא-אדום, פתיחה וסגירה אוטומטית. חוסך מים.', cat: 2, price: 890, sku: 'SF-003' },
    { name: 'ברז כיור מפל זכוכית', desc: 'ברז כיור עם פיית זכוכית מחוסמת, אפקט מפל מרהיב.', cat: 2, price: 680, sku: 'SF-004' },
    { name: 'סט ברז מקלחת שחור מט', desc: 'סט מקלחת מלא הכולל ברז, מזלף ידני וראש מקלחת. גימור שחור מט.', cat: 3, price: 1800, sku: 'SH-001' },
    { name: 'ברז מקלחת תרמוסטטי כרום', desc: 'ברז מקלחת עם בקרת טמפרטורה תרמוסטטית, בטיחותי ומדויק.', cat: 3, price: 2200, sku: 'SH-002' },
    { name: 'ברז מקלחת סמוי קיר שחור', desc: 'ברז מקלחת סמוי להתקנה בקיר, גימור שחור מט. מראה נקי.', cat: 3, price: 1600, sku: 'SH-003' },
    { name: 'ראש מקלחת גשם 30 ס"מ שחור', desc: 'ראש מקלחת גשם עגול 30 ס"מ, גימור שחור מט. התקנת תקרה.', cat: 4, price: 650, sku: 'RH-001' },
    { name: 'ראש מקלחת גשם 40 ס"מ כרום', desc: 'ראש מקלחת גשם מרובע 40 ס"מ, גימור כרום. זרם עדין ואחיד.', cat: 4, price: 850, sku: 'RH-002' },
    { name: 'ראש מקלחת עם תאורת LED', desc: 'ראש מקלחת עם תאורת LED משתנה לפי טמפרטורת המים. ללא חשמל.', cat: 4, price: 480, sku: 'RH-003' },
    { name: 'מתלה מגבות כפול שחור', desc: 'מתלה מגבות כפול 60 ס"מ, גימור שחור מט. התקנה קלה.', cat: 5, price: 180, sku: 'AC-001' },
    { name: 'מחזיק נייר טואלט זהב', desc: 'מחזיק נייר טואלט עם מכסה, גימור זהב מוברש.', cat: 5, price: 120, sku: 'AC-002' },
    { name: 'סבונייה תלויה כרום', desc: 'סבונייה תלויה מזכוכית וכרום, עיצוב קלאסי ואלגנטי.', cat: 5, price: 95, sku: 'AC-003' },
    { name: 'וו חלוק שחור מט', desc: 'וו תליה לחלוק או מגבת, גימור שחור מט. עיצוב מינימליסטי.', cat: 5, price: 65, sku: 'AC-004' },
  ];

  const allCategories = all('SELECT id FROM categories ORDER BY display_order');
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    db.run('INSERT INTO products (id, name, description, category_id, base_price, sku, finish, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), p.name, p.desc, allCategories[p.cat].id, p.price, p.sku, finishes[i], i]);
  }

  console.log('Database seeded with sample data');
}

module.exports = { initDb, run, runNoSave, get, all, saveDb, createBackup };
