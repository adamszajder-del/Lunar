// Inquiries Routes - /api/inquiries
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const crypto = require('crypto');

// Ensure message/size columns exist (runs once)
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
router.post('/', async (req, res) => {
  try {
    await ensureColumns();

    const userId = req.user?.id || null;
    const { product_id, message, size, phone } = req.body;

    if (!product_id) return res.status(400).json({ error: 'Product is required' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    // Get product info
    const product = await db.query('SELECT * FROM products WHERE id = $1', [product_id]);
    if (!product.rows[0]) return res.status(404).json({ error: 'Product not found' });

    const p = product.rows[0];
    const publicId = 'INQ-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    await db.query(
      `INSERT INTO orders (public_id, user_id, product_id, product_name, product_category, amount, message, size, phone, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'inquiry', NOW())`,
      [publicId, userId, p.id, p.name, p.category, p.price, message.trim(), size || null, phone || null]
    );

    log.info('New product inquiry', { publicId, product: p.name, userId });
    res.json({ success: true, inquiry_id: publicId });
  } catch (error) {
    log.error('Inquiry error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to send message: ' + error.message });
  }
});

module.exports = router;
