// News Routes - /api/news/*
const express = require('express');
const router = express.Router();
const db = require('../database');

// Get all news
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM news ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
