// Products Routes - /api/products/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const { cache, TTL } = require('../utils/cache');

// Get all products (public, cached) — Fix #10: pagination
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 500));
    const offset = (page - 1) * limit;
    const cacheKey = `products:${page}:${limit}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await db.query(`
      SELECT * FROM products 
      WHERE is_active = true 
      ORDER BY category, name
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    cache.set(cacheKey, result.rows, TTL.CATALOG);
    res.json(result.rows);
  } catch (error) {
    log.error('Get products error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get products for a specific view section (train, learn, calendar)
router.get('/view/:section', async (req, res) => {
  try {
    const section = req.params.section;
    const columnMap = {
      train: 'show_in_train',
      learn: 'show_in_learn',
      calendar: 'show_in_calendar',
    };

    const column = columnMap[section];
    if (!column) {
      return res.status(400).json({ error: 'Invalid section. Use: train, learn, calendar' });
    }

    const cacheKey = `products:view:${section}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await db.query(
      `SELECT id, public_id, name, description, price, category, image_url, icon, duration, gradient
       FROM products 
       WHERE is_active = true AND ${column} = true
       ORDER BY category, name`
    );

    cache.set(cacheKey, result.rows, TTL.CATALOG);
    res.json(result.rows);
  } catch (error) {
    // Graceful fallback if columns don't exist yet
    if (error.message && error.message.includes('column')) {
      return res.json([]);
    }
    log.error('Get products by view error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
