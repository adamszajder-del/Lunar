// HowTo Routes - /api/howto/*
// Staff checklist with per-day tracking (who checked, when)
// Task definitions stored in DB, managed from admin panel
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware, adminMiddleware, staffMiddleware } = require('../middleware/auth');
const { sanitizeString } = require('../utils/validators');
const log = require('../utils/logger');

// =========================================================================
// AUTO-MIGRATION: ensure tables exist
// =========================================================================
let tablesReady = false;
const ensureTables = async () => {
  if (tablesReady) return;
  try {
    // Tasks definition table
    await db.query(`
      CREATE TABLE IF NOT EXISTS howto_tasks (
        id SERIAL PRIMARY KEY,
        tab_key VARCHAR(50) NOT NULL,
        section_key VARCHAR(50) NOT NULL,
        task_key VARCHAR(80) NOT NULL,
        label VARCHAR(255) NOT NULL,
        position INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tab_key, section_key, task_key)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_howto_tasks_tab ON howto_tasks(tab_key, section_key)`);

    // Checks table (unchanged)
    await db.query(`
      CREATE TABLE IF NOT EXISTS howto_checks (
        id SERIAL PRIMARY KEY,
        checklist_date DATE NOT NULL,
        item_id VARCHAR(200) NOT NULL,
        checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        checked_by_name VARCHAR(100),
        checked_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(checklist_date, item_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_howto_checks_date ON howto_checks(checklist_date)`);

    tablesReady = true;
  } catch (e) {
    log.warn('howto tables migration', { error: e.message });
    tablesReady = true;
  }
};

// =========================================================================
// STAFF ROUTES (admin + coach + staff)
// =========================================================================
const staffRouter = express.Router();
staffRouter.use(authMiddleware);
staffRouter.use(staffMiddleware);

// GET /api/howto/tasks — all active tasks grouped by tab/section
staffRouter.get('/tasks', async (req, res) => {
  try {
    await ensureTables();
    const result = await db.query(
      `SELECT tab_key, section_key, task_key, label, position
       FROM howto_tasks
       WHERE is_active = true
       ORDER BY tab_key, section_key, position, id`
    );

    // Group: { reception: { open: [ {key, label}, ... ] } }
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.tab_key]) grouped[row.tab_key] = {};
      if (!grouped[row.tab_key][row.section_key]) grouped[row.tab_key][row.section_key] = [];
      grouped[row.tab_key][row.section_key].push({
        key: row.task_key,
        label: row.label,
        position: row.position
      });
    }

    res.json({ tasks: grouped });
  } catch (error) {
    log.error('Get howto tasks error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/howto/checklist/:date — all checks for a given date
staffRouter.get('/checklist/:date', async (req, res) => {
  try {
    await ensureTables();
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const result = await db.query(
      `SELECT item_id, checked_by, checked_by_name, checked_at
       FROM howto_checks WHERE checklist_date = $1 ORDER BY checked_at`,
      [date]
    );

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
staffRouter.post('/checklist/toggle', async (req, res) => {
  try {
    await ensureTables();
    const item_id = sanitizeString(req.body.item_id, 200);
    const date = req.body.date;

    if (!item_id || !date) {
      return res.status(400).json({ error: 'item_id and date are required' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Only allow toggling today's checklist
    const today = new Date().toISOString().split('T')[0];
    if (date !== today) {
      return res.status(403).json({ error: 'Can only modify today\'s checklist' });
    }

    const existing = await db.query(
      'SELECT id FROM howto_checks WHERE checklist_date = $1 AND item_id = $2',
      [date, item_id]
    );

    if (existing.rows.length > 0) {
      await db.query(
        'DELETE FROM howto_checks WHERE checklist_date = $1 AND item_id = $2',
        [date, item_id]
      );
      res.json({ checked: false, item_id, date });
    } else {
      const displayName = req.user.display_name || req.user.username;
      await db.query(
        `INSERT INTO howto_checks (checklist_date, item_id, checked_by, checked_by_name, checked_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [date, item_id, req.user.id, displayName]
      );
      res.json({
        checked: true, item_id, date,
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

// GET /api/howto/log/:date — daily timeline (all tabs)
staffRouter.get('/log/:date', async (req, res) => {
  try {
    await ensureTables();
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Join with tasks to get labels
    const result = await db.query(`
      SELECT
        hc.item_id,
        hc.checked_by,
        hc.checked_by_name,
        hc.checked_at,
        ht.label AS task_label,
        ht.tab_key,
        ht.section_key
      FROM howto_checks hc
      LEFT JOIN howto_tasks ht
        ON ht.tab_key || '-' || ht.section_key || '-' || ht.task_key = hc.item_id
        AND ht.is_active = true
      WHERE hc.checklist_date = $1
      ORDER BY hc.checked_at DESC
    `, [date]);

    res.json({ date, log: result.rows });
  } catch (error) {
    log.error('Get howto log error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// =========================================================================
// ADMIN ROUTES (admin only) — manage task definitions
// =========================================================================
const adminRouter = express.Router();
adminRouter.use(authMiddleware);
adminRouter.use(adminMiddleware);

// GET /api/howto/admin/tasks — all tasks (including inactive)
adminRouter.get('/tasks', async (req, res) => {
  try {
    await ensureTables();
    const result = await db.query(
      `SELECT * FROM howto_tasks ORDER BY tab_key, section_key, position, id`
    );
    res.json({ tasks: result.rows });
  } catch (error) {
    log.error('Admin get howto tasks error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/howto/admin/tasks — create task
adminRouter.post('/tasks', async (req, res) => {
  try {
    await ensureTables();
    const tab_key = sanitizeString(req.body.tab_key, 50);
    const section_key = sanitizeString(req.body.section_key, 50);
    const task_key = sanitizeString(req.body.task_key, 80);
    const label = sanitizeString(req.body.label, 255);
    const position = parseInt(req.body.position) || 0;

    if (!tab_key || !section_key || !task_key || !label) {
      return res.status(400).json({ error: 'tab_key, section_key, task_key, and label are required' });
    }

    // Validate task_key format: alphanumeric + underscore + hyphen
    if (!/^[a-z0-9_-]+$/.test(task_key)) {
      return res.status(400).json({ error: 'task_key must be lowercase alphanumeric with _ or -' });
    }

    const result = await db.query(
      `INSERT INTO howto_tasks (tab_key, section_key, task_key, label, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tab_key, section_key, task_key, label, position]
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Task key already exists for this tab/section' });
    }
    log.error('Admin create howto task error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/howto/admin/tasks/reorder — bulk update positions (MUST be before :id)
adminRouter.put('/tasks/reorder', async (req, res) => {
  try {
    const { items } = req.body; // [{ id, position }, ...]
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

    for (const item of items) {
      await db.query('UPDATE howto_tasks SET position = $1 WHERE id = $2', [item.position, item.id]);
    }
    res.json({ success: true });
  } catch (error) {
    log.error('Admin reorder howto tasks error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/howto/admin/tasks/:id — update task
adminRouter.put('/tasks/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const label = sanitizeString(req.body.label, 255);
    const position = parseInt(req.body.position) || 0;
    const is_active = req.body.is_active !== false;

    const result = await db.query(
      `UPDATE howto_tasks SET label = $1, position = $2, is_active = $3
       WHERE id = $4 RETURNING *`,
      [label, position, is_active, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json(result.rows[0]);
  } catch (error) {
    log.error('Admin update howto task error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/howto/admin/tasks/:id — delete task definition
// Note: historical checks using this task_key remain in howto_checks
adminRouter.delete('/tasks/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    await db.query('DELETE FROM howto_tasks WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    log.error('Admin delete howto task error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Mount sub-routers
router.use('/', staffRouter);
router.use('/admin', adminRouter);

module.exports = router;
