// Products Routes - /api/products/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');

// Get all products (public) — Fix #10: pagination
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 500));
    const offset = (page - 1) * limit;

    const result = await db.query(`
      SELECT * FROM products 
      WHERE is_active = true 
      ORDER BY category, name
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json(result.rows);
  } catch (error) {
    log.error('Get products error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
