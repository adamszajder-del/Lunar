// Training Plans Routes - /api/training-plans/*
// Public read-only access to training plans
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');

// GET /api/training-plans — all active plans (public)
router.get('/', async (req, res) => {
  try {
    const activityType = req.query.activity_type;
    let query = `
      SELECT id, public_id, name, description, activity_type, icon, color,
             duration, level, exercises, sort_order
      FROM training_plans
      WHERE is_active = true
    `;
    const params = [];
    if (activityType) {
      params.push(activityType);
      query += ` AND activity_type = $1`;
    }
    query += ` ORDER BY sort_order, name`;
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    log.error('Get training plans error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/training-plans/:id — single plan detail
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM training_plans WHERE (id = $1 OR public_id = $1) AND is_active = true',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Plan not found' });
    res.json(result.rows[0]);
  } catch (error) {
    log.error('Get training plan error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
