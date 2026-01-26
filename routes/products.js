// Products Routes - /api/products/*
const express = require('express');
const router = express.Router();
const db = require('../database');

// Get all products (public)
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM products 
      WHERE is_active = true 
      ORDER BY category, name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
