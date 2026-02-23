// Parks Routes - /api/parks/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const { cache, TTL } = require('../utils/cache');

// Get all active parks (public, cached)
router.get('/', async (req, res) => {
  try {
    const cacheKey = 'parks:all';
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await db.query(`
      SELECT * FROM parks 
      WHERE is_active = true 
      ORDER BY position ASC, name ASC
    `);
    cache.set(cacheKey, result.rows, TTL.CATALOG || 300);
    res.json(result.rows);
  } catch (error) {
    log.error('Get parks error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
