// Inquiries Routes - /api/inquiries
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const jwt = require('jsonwebtoken');
const config = require('../config');
const crypto = require('crypto');
const { sanitizeString, sanitizeNumber } = require('../utils/validators');
const { validateId } = require('../middleware/validateId');

// Optional auth — try to get user from token, don't block if missing
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const decoded = jwt.verify(token, config.JWT_SECRET);
      if (decoded.userId) {
        const result = await db.query('SELECT id, username, email FROM users WHERE id = $1', [decoded.userId]);
        if (result.rows[0]) req.user = result.rows[0];
      }
    }
  } catch (e) { /* ignore — proceed as guest */ }
  next();
};

// Ensure message/size/replied columns exist (runs once)
let columnsEnsured = false;
async function ensureColumns() {
  if (columnsEnsured) return;
  try {
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS message TEXT`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS size VARCHAR(20)`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS replied_by INTEGER`);
    columnsEnsured = true;
  } catch (err) {
    log.error('Ensure inquiry columns error', { error: err.message });
  }
}

// POST /api/inquiries — send a message/inquiry about a product
router.post('/', optionalAuth, async (req, res) => {
  try {
    await ensureColumns();

    const userId = req.user?.id || null;
    const productId = parseInt(req.body.product_id);
    const message = sanitizeString(req.body.message, 2000);
    const size = sanitizeString(req.body.size, 20);
    const phone = sanitizeString(req.body.phone, 50);

    if (!productId || isNaN(productId)) return res.status(400).json({ error: 'Valid product ID is required' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    // Validate phone format if provided
    if (phone && !/^[\d\s+\-().]{5,50}$/.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Get product info
    const product = await db.query('SELECT id, name, category, price FROM products WHERE id = $1', [productId]);
    if (!product.rows[0]) return res.status(404).json({ error: 'Product not found' });

    const p = product.rows[0];
    const publicId = 'INQ-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    await db.query(
      `INSERT INTO orders (public_id, user_id, product_id, product_name, product_category, amount, message, size, phone, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'inquiry', NOW())`,
      [publicId, userId, p.id, p.name, p.category, p.price, message.trim(), size || null, phone || null]
    );

    log.info('New product inquiry', { publicId, product: p.name, userId, username: req.user?.username });
    res.json({ success: true, inquiry_id: publicId });
  } catch (error) {
    log.error('Inquiry error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
