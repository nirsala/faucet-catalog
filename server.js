const express = require('express');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { initDb, run, runNoSave, get, all, saveDb, createBackup } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'faucet-catalog-secret-key-change-in-production';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});
const videoUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.webm', '.mov'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Auth
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  const user = get('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, role: user.role, display_name: user.display_name, store_slug: user.store_slug, logo_path: user.logo_path, price_color: user.price_color } });
});

// Categories
app.get('/api/categories', (req, res) => {
  res.json(all('SELECT * FROM categories ORDER BY display_order'));
});

app.post('/api/categories', authMiddleware, adminOnly, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const id = uuidv4();
  const maxOrder = get('SELECT MAX(display_order) as m FROM categories')?.m || 0;
  run('INSERT INTO categories (id, name, display_order) VALUES (?, ?, ?)', [id, name, maxOrder + 1]);
  res.json({ id, name });
});

app.put('/api/categories/:id', authMiddleware, adminOnly, (req, res) => {
  const { name, display_order } = req.body;
  if (name !== undefined) run('UPDATE categories SET name = ? WHERE id = ?', [name, req.params.id]);
  if (display_order !== undefined) run('UPDATE categories SET display_order = ? WHERE id = ?', [display_order, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/categories/:id', authMiddleware, adminOnly, (req, res) => {
  const products = get('SELECT COUNT(*) as c FROM products WHERE category_id = ?', [req.params.id]);
  if (products && products.c > 0) return res.status(400).json({ error: 'Category has products' });
  run('DELETE FROM categories WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Tags
app.get('/api/tags', (req, res) => {
  res.json(all('SELECT * FROM tags ORDER BY display_order'));
});

app.post('/api/tags', authMiddleware, adminOnly, (req, res) => {
  const { name } = req.body;
  const id = uuidv4();
  const maxOrder = get('SELECT MAX(display_order) as m FROM tags')?.m || 0;
  run('INSERT INTO tags (id, name, display_order) VALUES (?, ?, ?)', [id, name, maxOrder + 1]);
  res.json({ id, name });
});

app.delete('/api/tags/:id', authMiddleware, adminOnly, (req, res) => {
  run('DELETE FROM tags WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Finishes (legacy, now uses tags)
app.get('/api/finishes', (req, res) => {
  const tags = all('SELECT name FROM tags ORDER BY display_order');
  res.json(tags.map(t => t.name));
});

// Products
app.get('/api/products', (req, res) => {
  const { category_id, finish } = req.query;
  let query = `SELECT p.*, c.name as category_name FROM products p
    JOIN categories c ON p.category_id = c.id WHERE p.is_active = 1`;
  const params = [];
  if (category_id) { query += ' AND p.category_id = ?'; params.push(category_id); }
  if (finish) { query += ' AND p.finish = ?'; params.push(finish); }
  query += ' ORDER BY c.display_order, p.display_order';
  const products = all(query, params);

  // Attach extra images
  for (const p of products) {
    p.images = all('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order', [p.id]);
  }
  res.json(products);
});

app.post('/api/products', authMiddleware, adminOnly, upload.array('images', 10), (req, res) => {
  const { name, description, category_id, base_price, sku, finish } = req.body;
  const id = uuidv4();
  const image_path = req.files && req.files.length > 0 ? `/uploads/${req.files[0].filename}` : null;
  const maxOrder = get('SELECT MAX(display_order) as m FROM products WHERE category_id = ?', [category_id])?.m || 0;
  run('INSERT INTO products (id, name, description, category_id, base_price, image_path, sku, finish, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, description, category_id, parseFloat(base_price), image_path, sku, finish || null, maxOrder + 1]);

  // Save additional images
  if (req.files && req.files.length > 1) {
    for (let i = 1; i < req.files.length; i++) {
      run('INSERT INTO product_images (id, product_id, image_path, display_order) VALUES (?, ?, ?, ?)',
        [uuidv4(), id, `/uploads/${req.files[i].filename}`, i]);
    }
  }
  res.json({ id, name, image_path });
});

app.put('/api/products/:id', authMiddleware, adminOnly, upload.array('images', 10), (req, res) => {
  const { name, description, category_id, base_price, sku, finish } = req.body;
  if (name) run('UPDATE products SET name = ? WHERE id = ?', [name, req.params.id]);
  if (description) run('UPDATE products SET description = ? WHERE id = ?', [description, req.params.id]);
  if (category_id) run('UPDATE products SET category_id = ? WHERE id = ?', [category_id, req.params.id]);
  if (base_price) run('UPDATE products SET base_price = ? WHERE id = ?', [parseFloat(base_price), req.params.id]);
  if (sku) run('UPDATE products SET sku = ? WHERE id = ?', [sku, req.params.id]);
  if (finish !== undefined) run('UPDATE products SET finish = ? WHERE id = ?', [finish || null, req.params.id]);
  if (req.files && req.files.length > 0) {
    run('UPDATE products SET image_path = ? WHERE id = ?', [`/uploads/${req.files[0].filename}`, req.params.id]);
    // Save additional images
    for (let i = 1; i < req.files.length; i++) {
      run('INSERT INTO product_images (id, product_id, image_path, display_order) VALUES (?, ?, ?, ?)',
        [uuidv4(), req.params.id, `/uploads/${req.files[i].filename}`, i]);
    }
  }
  res.json({ success: true });
});

app.delete('/api/products/:id', authMiddleware, adminOnly, (req, res) => {
  run('UPDATE products SET is_active = 0 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Product images
app.get('/api/products/:id/images', (req, res) => {
  const product = get('SELECT image_path FROM products WHERE id = ?', [req.params.id]);
  const extra = all('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order', [req.params.id]);
  const images = [];
  if (product && product.image_path) images.push({ id: 'main', image_path: product.image_path, display_order: 0 });
  images.push(...extra);
  res.json(images);
});

app.post('/api/products/:id/images', authMiddleware, adminOnly, upload.array('images', 10), (req, res) => {
  if (!req.files) return res.status(400).json({ error: 'No files' });
  const maxOrder = get('SELECT MAX(display_order) as m FROM product_images WHERE product_id = ?', [req.params.id])?.m || 0;
  for (let i = 0; i < req.files.length; i++) {
    run('INSERT INTO product_images (id, product_id, image_path, display_order) VALUES (?, ?, ?, ?)',
      [uuidv4(), req.params.id, `/uploads/${req.files[i].filename}`, maxOrder + i + 1]);
  }
  res.json({ success: true });
});

app.delete('/api/product-images/:imageId', authMiddleware, adminOnly, (req, res) => {
  run('DELETE FROM product_images WHERE id = ?', [req.params.imageId]);
  res.json({ success: true });
});

// Dealers
app.get('/api/dealers', authMiddleware, adminOnly, (req, res) => {
  res.json(all('SELECT id, username, display_name, store_slug, logo_path, is_active, created_at FROM users WHERE role = ?', ['dealer']));
});

app.post('/api/dealers', authMiddleware, adminOnly, (req, res) => {
  const { username, password, display_name } = req.body || {};
  if (!username || !password || !display_name) return res.status(400).json({ error: 'Missing required fields' });
  const id = uuidv4();
  const store_slug = username.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const hashedPassword = bcrypt.hashSync(password, 10);
  const existing = get('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) return res.status(400).json({ error: 'Username already exists' });
  run('INSERT INTO users (id, username, password, display_name, role, store_slug) VALUES (?, ?, ?, ?, ?, ?)',
    [id, username, hashedPassword, display_name, 'dealer', store_slug]);
  res.json({ id, username, display_name, store_slug });
});

app.put('/api/dealers/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { display_name, password, is_active, price_color } = req.body;
  if (password) run('UPDATE users SET password = ? WHERE id = ?', [bcrypt.hashSync(password, 10), req.params.id]);
  if (display_name !== undefined) run('UPDATE users SET display_name = ? WHERE id = ?', [display_name, req.params.id]);
  if (is_active !== undefined && req.user.role === 'admin') run('UPDATE users SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
  if (price_color !== undefined) run('UPDATE users SET price_color = ? WHERE id = ?', [price_color || null, req.params.id]);
  res.json({ success: true });
});

// Dealer logo
app.post('/api/dealers/:id/logo', authMiddleware, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const logo_path = `/uploads/${req.file.filename}`;
  run('UPDATE users SET logo_path = ? WHERE id = ?', [logo_path, req.params.id]);
  res.json({ logo_path });
});

// Dealer prices
app.get('/api/dealer-prices/:dealerId', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.dealerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(all('SELECT * FROM dealer_prices WHERE dealer_id = ?', [req.params.dealerId]));
});

app.post('/api/dealer-prices', authMiddleware, (req, res) => {
  const { product_id, price, dealer_id } = req.body;
  const targetDealer = req.user.role === 'admin' ? dealer_id : req.user.id;
  const existing = get('SELECT id FROM dealer_prices WHERE dealer_id = ? AND product_id = ?', [targetDealer, product_id]);
  if (existing) {
    run('UPDATE dealer_prices SET price = ?, updated_at = datetime("now") WHERE dealer_id = ? AND product_id = ?',
      [parseFloat(price), targetDealer, product_id]);
  } else {
    run('INSERT INTO dealer_prices (id, dealer_id, product_id, price) VALUES (?, ?, ?, ?)',
      [uuidv4(), targetDealer, product_id, parseFloat(price)]);
  }
  res.json({ success: true });
});

app.post('/api/dealer-prices/bulk', authMiddleware, (req, res) => {
  const { prices, dealer_id } = req.body || {};
  if (!prices || !Array.isArray(prices)) return res.status(400).json({ error: 'Missing prices array' });
  const targetDealer = req.user.role === 'admin' ? dealer_id : req.user.id;
  const changeDetails = [];

  for (const p of prices) {
    const product = get('SELECT name, base_price FROM products WHERE id = ?', [p.product_id]);
    const existing = get('SELECT id, price FROM dealer_prices WHERE dealer_id = ? AND product_id = ?', [targetDealer, p.product_id]);
    const oldPrice = existing ? existing.price : null;
    const newPrice = parseFloat(p.price);

    if (existing) {
      runNoSave('UPDATE dealer_prices SET price = ?, updated_at = datetime("now") WHERE dealer_id = ? AND product_id = ?',
        [newPrice, targetDealer, p.product_id]);
    } else {
      runNoSave('INSERT INTO dealer_prices (id, dealer_id, product_id, price) VALUES (?, ?, ?, ?)',
        [uuidv4(), targetDealer, p.product_id, newPrice]);
    }

    if (product && (oldPrice === null || oldPrice !== newPrice)) {
      changeDetails.push({
        product_name: product.name,
        base_price: product.base_price,
        old_price: oldPrice,
        new_price: newPrice
      });
    }
  }
  saveDb();

  if (req.user.role === 'dealer' && changeDetails.length > 0) {
    const dealer = get('SELECT display_name FROM users WHERE id = ?', [req.user.id]);
    if (dealer) {
      run('INSERT INTO notifications (id, type, message, dealer_id, details) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), 'price_update', `${dealer.display_name} עדכן/ה ${changeDetails.length} מחירים`, req.user.id, JSON.stringify(changeDetails)]);
    }
  }

  res.json({ success: true });
});

// Excel export
app.get('/api/export/:dealerId', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.dealerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const dealer = get('SELECT display_name FROM users WHERE id = ?', [req.params.dealerId]);
  const products = all(`
    SELECT p.name, p.sku, p.finish, c.name as category_name, p.base_price,
           dp.price as dealer_price
    FROM products p
    JOIN categories c ON p.category_id = c.id
    LEFT JOIN dealer_prices dp ON dp.product_id = p.id AND dp.dealer_id = ?
    WHERE p.is_active = 1
    ORDER BY c.display_order, p.display_order
  `, [req.params.dealerId]);

  // Generate CSV with BOM for Hebrew Excel support
  const BOM = '﻿';
  let csv = BOM + 'קטגוריה,שם מוצר,מק"ט,גימור,מחיר בסיס,מחיר דילר\n';
  for (const p of products) {
    const dealerPrice = p.dealer_price || '';
    csv += `"${p.category_name}","${p.name}","${p.sku || ''}","${p.finish || ''}",${p.base_price},${dealerPrice}\n`;
  }

  const filename = `prices-${dealer?.display_name || 'dealer'}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(csv);
});

// Product order per dealer
app.get('/api/dealer-order/:dealerId', authMiddleware, (req, res) => {
  res.json(all('SELECT * FROM dealer_product_order WHERE dealer_id = ? ORDER BY display_order', [req.params.dealerId]));
});

app.post('/api/dealer-order/:dealerId', authMiddleware, adminOnly, (req, res) => {
  const { product_orders } = req.body || {};
  if (!product_orders || !Array.isArray(product_orders)) return res.status(400).json({ error: 'Missing product_orders array' });
  for (const po of product_orders) {
    const existing = get('SELECT id FROM dealer_product_order WHERE dealer_id = ? AND product_id = ?', [req.params.dealerId, po.product_id]);
    if (existing) {
      runNoSave('UPDATE dealer_product_order SET display_order = ? WHERE dealer_id = ? AND product_id = ?',
        [po.order, req.params.dealerId, po.product_id]);
    } else {
      runNoSave('INSERT INTO dealer_product_order (id, dealer_id, product_id, display_order) VALUES (?, ?, ?, ?)',
        [uuidv4(), req.params.dealerId, po.product_id, po.order]);
    }
  }
  saveDb();
  res.json({ success: true });
});

// Click tracking
app.post('/api/clicks', (req, res) => {
  const { product_id, dealer_id } = req.body || {};
  if (!product_id) return res.status(400).json({ error: 'Missing product_id' });
  run('INSERT INTO product_clicks (product_id, dealer_id) VALUES (?, ?)', [product_id, dealer_id || null]);
  res.json({ success: true });
});

app.get('/api/clicks/stats', authMiddleware, adminOnly, (req, res) => {
  const { dealer_id } = req.query;
  if (dealer_id) {
    res.json(all(`SELECT product_id, dealer_id, COUNT(*) as click_count,
      MAX(clicked_at) as last_clicked FROM product_clicks WHERE dealer_id = ?
      GROUP BY product_id, dealer_id ORDER BY click_count DESC`, [dealer_id]));
  } else {
    res.json(all(`SELECT product_id, dealer_id, COUNT(*) as click_count,
      MAX(clicked_at) as last_clicked FROM product_clicks
      GROUP BY product_id, dealer_id ORDER BY click_count DESC`));
  }
});

// Notifications
app.get('/api/notifications', authMiddleware, adminOnly, (req, res) => {
  const notifs = all('SELECT n.*, u.display_name as dealer_name FROM notifications n LEFT JOIN users u ON n.dealer_id = u.id ORDER BY n.created_at DESC LIMIT 50');
  notifs.forEach(n => { if (n.details) try { n.details = JSON.parse(n.details); } catch {} });
  res.json(notifs);
});

app.get('/api/notifications/unread-count', authMiddleware, adminOnly, (req, res) => {
  const result = get('SELECT COUNT(*) as c FROM notifications WHERE is_read = 0');
  res.json({ count: result?.c || 0 });
});

app.post('/api/notifications/mark-read', authMiddleware, adminOnly, (req, res) => {
  run('UPDATE notifications SET is_read = 1 WHERE is_read = 0');
  res.json({ success: true });
});

// Backup
app.post('/api/backup', authMiddleware, adminOnly, (req, res) => {
  createBackup();
  res.json({ success: true, message: 'Backup created' });
});

// Settings
app.get('/api/settings', (req, res) => {
  const rows = all('SELECT key, value FROM settings');
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.put('/api/settings', authMiddleware, adminOnly, (req, res) => {
  const entries = req.body;
  for (const [key, value] of Object.entries(entries)) {
    const existing = get('SELECT key FROM settings WHERE key = ?', [key]);
    if (existing) {
      runNoSave('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
    } else {
      runNoSave('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }
  saveDb();
  res.json({ success: true });
});

// Video upload for landing page
app.post('/api/settings/video', authMiddleware, adminOnly, videoUpload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const video_path = `/uploads/${req.file.filename}`;
  // Also copy to public/videos/promo.mp4 for backward compat
  const destDir = path.join(__dirname, 'public', 'videos');
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'uploads', req.file.filename), path.join(destDir, 'promo.mp4'));
  const existing = get('SELECT key FROM settings WHERE key = ?', ['landing_video']);
  if (existing) {
    run('UPDATE settings SET value = ? WHERE key = ?', [video_path, 'landing_video']);
  } else {
    run('INSERT INTO settings (key, value) VALUES (?, ?)', ['landing_video', video_path]);
  }
  res.json({ video_path });
});

// Enhanced click stats
app.get('/api/clicks/top-products', authMiddleware, adminOnly, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  res.json(all(`
    SELECT p.id, p.name, p.sku, p.image_path, p.finish, c.name as category_name,
           COUNT(pc.id) as click_count, MAX(pc.clicked_at) as last_clicked
    FROM product_clicks pc
    JOIN products p ON pc.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    GROUP BY p.id
    ORDER BY click_count DESC
    LIMIT ?
  `, [limit]));
});

app.get('/api/clicks/top-stores', authMiddleware, adminOnly, (req, res) => {
  res.json(all(`
    SELECT u.id, u.display_name, u.store_slug, u.logo_path,
           COUNT(pc.id) as click_count,
           COUNT(DISTINCT pc.product_id) as unique_products,
           MAX(pc.clicked_at) as last_activity
    FROM product_clicks pc
    JOIN users u ON pc.dealer_id = u.id
    GROUP BY u.id
    ORDER BY click_count DESC
  `));
});

app.get('/api/clicks/daily', authMiddleware, adminOnly, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  res.json(all(`
    SELECT DATE(clicked_at) as date, COUNT(*) as clicks
    FROM product_clicks
    WHERE clicked_at >= datetime('now', '-' || ? || ' days')
    GROUP BY DATE(clicked_at)
    ORDER BY date ASC
  `, [days]));
});

app.get('/api/clicks/summary', authMiddleware, adminOnly, (req, res) => {
  const total = get('SELECT COUNT(*) as c FROM product_clicks');
  const today = get("SELECT COUNT(*) as c FROM product_clicks WHERE DATE(clicked_at) = DATE('now')");
  const week = get("SELECT COUNT(*) as c FROM product_clicks WHERE clicked_at >= datetime('now', '-7 days')");
  const uniqueProducts = get('SELECT COUNT(DISTINCT product_id) as c FROM product_clicks');
  const uniqueStores = get('SELECT COUNT(DISTINCT dealer_id) as c FROM product_clicks WHERE dealer_id IS NOT NULL');
  res.json({
    total: total?.c || 0,
    today: today?.c || 0,
    this_week: week?.c || 0,
    unique_products: uniqueProducts?.c || 0,
    unique_stores: uniqueStores?.c || 0
  });
});

// Cart events
app.post('/api/cart-events', (req, res) => {
  const { dealer_id, product_ids, product_count, total_price } = req.body;
  run('INSERT INTO cart_events (dealer_id, product_ids, product_count, total_price) VALUES (?, ?, ?, ?)',
    [dealer_id || null, JSON.stringify(product_ids || []), product_count || 0, total_price || 0]);
  res.json({ success: true });
});

app.get('/api/cart-events/summary', authMiddleware, adminOnly, (req, res) => {
  const total = get('SELECT COUNT(*) as c FROM cart_events');
  const today = get("SELECT COUNT(*) as c FROM cart_events WHERE DATE(created_at) = DATE('now')");
  const week = get("SELECT COUNT(*) as c FROM cart_events WHERE created_at >= datetime('now', '-7 days')");
  const avgProducts = get('SELECT AVG(product_count) as avg FROM cart_events');
  const avgPrice = get('SELECT AVG(total_price) as avg FROM cart_events WHERE total_price > 0');
  res.json({
    total: total?.c || 0,
    today: today?.c || 0,
    this_week: week?.c || 0,
    avg_products: Math.round((avgProducts?.avg || 0) * 10) / 10,
    avg_price: Math.round((avgPrice?.avg || 0))
  });
});

app.get('/api/cart-events/top-products', authMiddleware, adminOnly, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const events = all('SELECT product_ids FROM cart_events WHERE product_ids IS NOT NULL');
  const counts = {};
  events.forEach(e => {
    try {
      const ids = JSON.parse(e.product_ids);
      ids.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
    } catch {}
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const results = sorted.map(([pid, count]) => {
    const p = get(`SELECT p.id, p.name, p.sku, p.image_path, c.name as category_name
      FROM products p JOIN categories c ON p.category_id = c.id WHERE p.id = ?`, [pid]);
    return p ? { ...p, cart_count: count } : null;
  }).filter(Boolean);
  res.json(results);
});

app.get('/api/cart-events/by-store', authMiddleware, adminOnly, (req, res) => {
  res.json(all(`
    SELECT u.id, u.display_name, u.store_slug, u.logo_path,
           COUNT(ce.id) as cart_count,
           AVG(ce.product_count) as avg_products,
           MAX(ce.created_at) as last_activity
    FROM cart_events ce
    JOIN users u ON ce.dealer_id = u.id
    GROUP BY u.id
    ORDER BY cart_count DESC
  `));
});

// Dealer-specific stats (for dealer panel)
app.get('/api/dealer-stats/summary', authMiddleware, (req, res) => {
  const dealerId = req.user.id;
  const total = get('SELECT COUNT(*) as c FROM product_clicks WHERE dealer_id = ?', [dealerId]);
  const today = get("SELECT COUNT(*) as c FROM product_clicks WHERE dealer_id = ? AND DATE(clicked_at) = DATE('now')", [dealerId]);
  const week = get("SELECT COUNT(*) as c FROM product_clicks WHERE dealer_id = ? AND clicked_at >= datetime('now', '-7 days')", [dealerId]);
  const month = get("SELECT COUNT(*) as c FROM product_clicks WHERE dealer_id = ? AND clicked_at >= datetime('now', '-30 days')", [dealerId]);
  const uniqueProducts = get('SELECT COUNT(DISTINCT product_id) as c FROM product_clicks WHERE dealer_id = ?', [dealerId]);
  res.json({
    total: total?.c || 0,
    today: today?.c || 0,
    this_week: week?.c || 0,
    this_month: month?.c || 0,
    unique_products: uniqueProducts?.c || 0
  });
});

app.get('/api/dealer-stats/top-products', authMiddleware, (req, res) => {
  const dealerId = req.user.id;
  const limit = parseInt(req.query.limit) || 10;
  res.json(all(`
    SELECT p.id, p.name, p.sku, p.image_path, p.finish, c.name as category_name,
           COUNT(pc.id) as click_count, MAX(pc.clicked_at) as last_clicked
    FROM product_clicks pc
    JOIN products p ON pc.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    WHERE pc.dealer_id = ?
    GROUP BY p.id
    ORDER BY click_count DESC
    LIMIT ?
  `, [dealerId, limit]));
});

app.get('/api/dealer-stats/daily', authMiddleware, (req, res) => {
  const dealerId = req.user.id;
  const days = parseInt(req.query.days) || 30;
  res.json(all(`
    SELECT DATE(clicked_at) as date, COUNT(*) as clicks
    FROM product_clicks
    WHERE dealer_id = ? AND clicked_at >= datetime('now', '-' || ? || ' days')
    GROUP BY DATE(clicked_at)
    ORDER BY date ASC
  `, [dealerId, days]));
});

app.get('/api/dealer-stats/by-category', authMiddleware, (req, res) => {
  const dealerId = req.user.id;
  res.json(all(`
    SELECT c.name as category_name, COUNT(pc.id) as click_count
    FROM product_clicks pc
    JOIN products p ON pc.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    WHERE pc.dealer_id = ?
    GROUP BY c.id
    ORDER BY click_count DESC
  `, [dealerId]));
});

app.get('/api/dealer-stats/hourly', authMiddleware, (req, res) => {
  const dealerId = req.user.id;
  res.json(all(`
    SELECT CAST(strftime('%H', clicked_at) AS INTEGER) as hour, COUNT(*) as clicks
    FROM product_clicks
    WHERE dealer_id = ?
    GROUP BY hour
    ORDER BY hour ASC
  `, [dealerId]));
});

// Store page (public)
app.get('/api/store/:slug', (req, res) => {
  const dealer = get('SELECT id, display_name, store_slug, logo_path, price_color FROM users WHERE store_slug = ? AND is_active = 1 AND role = ?',
    [req.params.slug, 'dealer']);
  if (!dealer) return res.status(404).json({ error: 'Store not found' });

  const products = all(`
    SELECT p.*, c.name as category_name, c.display_order as cat_order,
           dp.price as dealer_price,
           COALESCE(dpo.display_order, p.display_order) as sort_order
    FROM products p
    JOIN categories c ON p.category_id = c.id
    LEFT JOIN dealer_prices dp ON dp.product_id = p.id AND dp.dealer_id = ?
    LEFT JOIN dealer_product_order dpo ON dpo.product_id = p.id AND dpo.dealer_id = ?
    WHERE p.is_active = 1
    ORDER BY c.display_order, sort_order
  `, [dealer.id, dealer.id]);

  // Attach extra images to each product
  for (const p of products) {
    p.images = all('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order', [p.id]);
  }

  // Get settings for landing page
  const settingsRows = all('SELECT key, value FROM settings');
  const settings = {};
  settingsRows.forEach(r => settings[r.key] = r.value);

  res.json({ dealer, products, settings });
});

// Serve pages
app.get('/store/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'store.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/dealer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dealer.html'));
});

// Service worker
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Start
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`Login: admin / admin123`);
  });
}).catch(err => {
  console.error('Failed to init database:', err);
  process.exit(1);
});
