// HowTo Routes - /api/howto/*
// Staff checklist with per-day tracking (who checked, when)
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware, staffMiddleware } = require('../middleware/auth');
const log = require('../utils/logger');

// All howto routes require staff auth (admin, coach, or staff)
router.use(authMiddleware);
router.use(staffMiddleware);

// Ensure table exists on first load
let tableReady = false;
const ensureTable = async () => {
  if (tableReady) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS howto_checks (
        id SERIAL PRIMARY KEY,
        checklist_date DATE NOT NULL,
        item_id VARCHAR(100) NOT NULL,
        checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        checked_by_name VARCHAR(100),
        checked_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(checklist_date, item_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_howto_checks_date ON howto_checks(checklist_date)`);
    tableReady = true;
  } catch (e) {
    log.warn('howto_checks table may already exist', { error: e.message });
    tableReady = true;
  }
};

// GET /api/howto/checklist/:date — get all checks for a given date
// Date format: YYYY-MM-DD
router.get('/checklist/:date', async (req, res) => {
  try {
    await ensureTable();
    const { date } = req.params;

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const result = await db.query(
      `SELECT item_id, checked_by, checked_by_name, checked_at
       FROM howto_checks
       WHERE checklist_date = $1
       ORDER BY checked_at`,
      [date]
    );

    // Return as a map: { "reception-open-1": { checked_by_name: "Anna", checked_at: "..." } }
    const checks = {};
    for (const row of result.rows) {
      checks[row.item_id] = {
        checked_by: row.checked_by,
        checked_by_name: row.checked_by_name,
        checked_at: row.checked_at
      };
    }

    res.json({ date, checks });
  } catch (error) {
    log.error('Get howto checklist error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/howto/checklist/toggle — toggle a checklist item (today only)
// Body: { item_id, date }
router.post('/checklist/toggle', async (req, res) => {
  try {
    await ensureTable();
    const { item_id, date } = req.body;

    if (!item_id || !date) {
      return res.status(400).json({ error: 'item_id and date are required' });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Only allow toggling today's checklist
    const today = new Date().toISOString().split('T')[0];
    if (date !== today) {
      return res.status(403).json({ error: 'Can only modify today\'s checklist' });
    }

    // Check if already checked
    const existing = await db.query(
      'SELECT id FROM howto_checks WHERE checklist_date = $1 AND item_id = $2',
      [date, item_id]
    );

    if (existing.rows.length > 0) {
      // Uncheck — delete
      await db.query(
        'DELETE FROM howto_checks WHERE checklist_date = $1 AND item_id = $2',
        [date, item_id]
      );
      res.json({ checked: false, item_id, date });
    } else {
      // Check — insert
      const displayName = req.user.display_name || req.user.username;
      await db.query(
        `INSERT INTO howto_checks (checklist_date, item_id, checked_by, checked_by_name, checked_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [date, item_id, req.user.id, displayName]
      );
      res.json({
        checked: true,
        item_id,
        date,
        checked_by: req.user.id,
        checked_by_name: displayName,
        checked_at: new Date().toISOString()
      });
    }
  } catch (error) {
    log.error('Toggle howto check error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
