// Tricks Routes - /api/tricks/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const log = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');
const { cache, TTL } = require('../utils/cache');
const { validateId } = require('../middleware/validateId');
const { STATUS } = require('../utils/constants');
const { logTriggerExecution } = require('../utils/levelLogger'); // ← LEVEL SYSTEM

// Get trick categories (lightweight — just names + counts, for category grid)
router.get('/categories', async (req, res) => {
  try {
    const cached = cache.get('tricks:categories');
    if (cached) return res.json(cached);

    const result = await db.query(`
      SELECT category, COUNT(*) as trick_count,
        MIN(difficulty) as min_difficulty, MAX(difficulty) as max_difficulty
      FROM tricks 
      GROUP BY category
      ORDER BY category
    `);
    cache.set('tricks:categories', result.rows, TTL.CATALOG);
    res.json(result.rows);
  } catch (error) {
    log.error('Get trick categories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get tricks — with optional category filter (for lazy loading per category)
// Without category: returns all tricks (cached catalog for progress tracking)
// With category: returns tricks for that category with image_url
router.get('/', async (req, res) => {
  try {
    const category = req.query.category;
    
    if (category) {
      // Category-specific: return tricks with images for category view
      const cacheKey = `tricks:cat:${category}`;
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);

      const result = await db.query(
        'SELECT id, public_id, name, category, difficulty, description, image_url, position FROM tricks WHERE category = $1 ORDER BY difficulty, position',
        [category]
      );
      cache.set(cacheKey, result.rows, TTL.CATALOG);
      res.json(result.rows);
    } else {
      // Full catalog: lightweight (no image_url), for progress tracking
      const cached = cache.get('tricks:all');
      if (cached) return res.json(cached);

      const result = await db.query('SELECT id, public_id, name, category, difficulty, description, video_url, image_url, position, created_at FROM tricks ORDER BY category, difficulty');
      cache.set('tricks:all', result.rows, TTL.CATALOG);
      res.json(result.rows);
    }
  } catch (error) {
    log.error('Get tricks error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single trick detail with sections (lazy loaded)
router.get('/:id/detail', validateId('id'), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT sections, full_description FROM tricks WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trick not found' });
    res.json(result.rows[0]);
  } catch (error) {
    log.error('Get trick detail error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's trick progress
router.get('/progress', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT trick_id, status, COALESCE(goofy_status, \'todo\') as goofy_status, notes FROM user_tricks WHERE user_id = $1',
      [req.user.id]
    );
    
    // Convert to object format { trickId: { status, goofy_status, notes } }
    const progress = {};
    result.rows.forEach(row => {
      progress[row.trick_id] = { status: row.status, goofy_status: row.goofy_status, notes: row.notes };
    });
    
    res.json(progress);
  } catch (error) {
    log.error('Get progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update trick progress
router.post('/progress', authMiddleware, async (req, res) => {
  try {
    const { trickId, status, notes, stance } = req.body;

    if (!trickId) {
      return res.status(400).json({ error: 'Trick ID is required' });
    }

    const validStatuses = [STATUS.TODO, STATUS.IN_PROGRESS, STATUS.MASTERED];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: todo, in_progress, or mastered' });
    }

    if (stance === 'goofy') {
      await db.query(`
        INSERT INTO user_tricks (user_id, trick_id, goofy_status)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, trick_id)
        DO UPDATE SET goofy_status = $3, updated_at = NOW()
      `, [req.user.id, trickId, status]);
    } else {
      await db.query(`
        INSERT INTO user_tricks (user_id, trick_id, status, notes)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, trick_id)
        DO UPDATE SET status = $3, notes = $4, updated_at = NOW()
      `, [req.user.id, trickId, status, notes || '']);
    }

    // Invalidate caches that depend on trick progress
    cache.invalidatePrefix('bootstrap:');
    cache.invalidate('crew:all');
    // ← LEVEL SYSTEM: Invalidate level caches
    cache.invalidate(`user:${req.user.id}:level`);
    cache.invalidate(`user:${req.user.id}:stats`);
    cache.invalidatePrefix('leaderboard:levels:');

    // ── MILESTONE DETECTION (only on mastered) ──
    if (status === STATUS.MASTERED) {
      try {
        // Ensure milestones table
        await db.query(`
          CREATE TABLE IF NOT EXISTS user_milestones (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            milestone_type VARCHAR(50) NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            data JSONB DEFAULT '{}',
            achieved_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, milestone_type, title)
          )
        `);

        // Count mastered tricks (both stances)
        const countRes = await db.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status = 'mastered') as regular_count,
            COUNT(*) FILTER (WHERE COALESCE(goofy_status, 'todo') = 'mastered') as goofy_count
          FROM user_tricks WHERE user_id = $1
        `, [req.user.id]);
        const totalMastered = parseInt(countRes.rows[0].regular_count) + parseInt(countRes.rows[0].goofy_count);

        // Get trick category
        const trickRes = await db.query('SELECT name, category FROM tricks WHERE id = $1', [trickId]);
        const trickCategory = trickRes.rows[0]?.category;
        const trickName = trickRes.rows[0]?.name;

        const milestones = [];

        // First trick ever
        if (totalMastered === 1) {
          milestones.push({
            type: 'first_trick',
            title: 'First trick landed!',
            description: `${trickName} — the journey begins`,
            data: { trick_name: trickName, category: trickCategory }
          });
        }

        // Trick count milestones
        const countMilestones = [10, 25, 50, 100, 150, 200];
        for (const n of countMilestones) {
          if (totalMastered === n) {
            milestones.push({
              type: 'trick_count',
              title: `${n} tricks mastered!`,
              description: n >= 100 ? 'Absolute legend status' : n >= 50 ? 'Half century of tricks' : `${n} tricks and counting`,
              data: { count: n }
            });
          }
        }

        // First trick in a category
        if (trickCategory) {
          const catCountRes = await db.query(`
            SELECT COUNT(*) as cnt FROM user_tricks ut
            JOIN tricks t ON ut.trick_id = t.id
            WHERE ut.user_id = $1 AND t.category = $2 
              AND (ut.status = 'mastered' OR COALESCE(ut.goofy_status, 'todo') = 'mastered')
          `, [req.user.id, trickCategory]);
          if (parseInt(catCountRes.rows[0].cnt) === 1) {
            milestones.push({
              type: 'category_first',
              title: `First ${trickCategory.replace(/_/g, ' ')} trick!`,
              description: `${trickName} — new territory unlocked`,
              data: { category: trickCategory, trick_name: trickName }
            });
          }
        }

        // Insert milestones (ignore duplicates)
        for (const ms of milestones) {
          await db.query(`
            INSERT INTO user_milestones (user_id, milestone_type, title, description, data)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id, milestone_type, title) DO NOTHING
          `, [req.user.id, ms.type, ms.title, ms.description, JSON.stringify(ms.data)]);
        }
      } catch (msErr) {
        log.warn('Milestone detection error (non-fatal):', { userId: req.user.id, error: msErr.message });
      }
    }

    // ← LEVEL SYSTEM: Log level trigger
    try {
      logTriggerExecution(req.user.id, trickId, stance, 'updated', status, 'unknown');
    } catch (logErr) {
      log.warn('Level logging failed:', { userId: req.user.id, error: logErr.message });
    }

    res.json({ success: true });
  } catch (error) {
    log.error('Update progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Share a mastered trick to feed (opt-in from SharePrompt)
router.post('/:trickId/share', authMiddleware, async (req, res) => {
  try {
    const trickId = parseInt(req.params.trickId);
    const userId = req.user.id;
    const { stance, comment } = req.body;

    if (!trickId || isNaN(trickId)) {
      return res.status(400).json({ error: 'Invalid trick ID' });
    }

    // Ensure table exists (safe, no-op after first call)
    await db.query(`
      CREATE TABLE IF NOT EXISTS shared_tricks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        trick_id INTEGER REFERENCES tricks(id) ON DELETE CASCADE,
        stance VARCHAR(10) DEFAULT 'regular',
        comment TEXT,
        shared_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, trick_id, stance)
      )
    `);

    // Insert (upsert — re-sharing updates comment/timestamp)
    await db.query(`
      INSERT INTO shared_tricks (user_id, trick_id, stance, comment)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, trick_id, stance)
      DO UPDATE SET comment = $4, shared_at = NOW()
    `, [userId, trickId, stance || 'regular', comment || null]);

    // Invalidate feed cache
    cache.invalidatePrefix('bootstrap:');

    res.json({ success: true, shared: true });
  } catch (error) {
    log.error('Share trick error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
