// Partners Routes - /api/partners/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const { cache, TTL } = require('../utils/cache');

// Get all active partners (public, cached)
router.get('/', async (req, res) => {
  try {
    const cacheKey = 'partners:all';
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await db.query(`
      SELECT * FROM partners 
      WHERE is_active = true 
      ORDER BY position ASC, name ASC
    `);
    cache.set(cacheKey, result.rows, TTL.CATALOG || 300);
    res.json(result.rows);
  } catch (error) {
    if (error.code === '42P01') return res.json([]);
    log.error('Get partners error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
