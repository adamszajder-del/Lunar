// ============================================================================
// LEVEL SYSTEM ROUTES - /api/level/*
// Place in: backend/routes/levelSystem.js
// Add to index.js: router.use('/level', levelSystemRoutes);
// ============================================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { validateId } = require('../middleware/validateId');
const { STATUS } = require('../utils/constants');
const { cache, TTL } = require('../utils/cache');
const log = require('../utils/logger');
const { logLevelCalculation, logLevelFetch, validateLevelConsistency, logLeaderboardCalculation } = require('../utils/levelLogger');

// ============================================================================
// GET /api/level/user/:id
// Get user's current level, points, and progression
// Public endpoint (anyone can see any user's level)
// ============================================================================
router.get('/user/:id', validateId('id'), async (req, res) => {
  try {
    const userId = req.params.id;
    const cacheKey = `user:${userId}:level`;
    
    // Check cache first
    const cached = cache.get(cacheKey);
    if (cached) {
      logLevelFetch(userId, cached, 'cache');
      return res.json(cached);
    }

    const result = await db.query(`
      SELECT 
        id,
        username,
        display_name,
        avatar_base64,
        current_level,
        level_points,
        level_updated_at,
        level_calculation_count
      FROM users 
      WHERE id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Calculate points to next level
    const LEVEL_THRESHOLDS = {
      1: { min: 0, max: 20, name: 'Wakeboarder', icon: '🌊' },
      2: { min: 20, max: 40, name: 'Rider', icon: '🏄' },
      3: { min: 40, max: 60, name: 'Progressor', icon: '📈' },
      4: { min: 60, max: 80, name: 'Advanced Rider', icon: '⚡' },
      5: { min: 80, max: 110, name: 'Trick Master', icon: '🎯' },
      6: { min: 110, max: 140, name: 'Pro', icon: '👑' },
      7: { min: 140, max: 170, name: 'Expert', icon: '⭐' },
      8: { min: 170, max: 200, name: 'Master', icon: '🔥' },
      9: { min: 200, max: 230, name: 'Legend', icon: '👹' },
      10: { min: 230, max: Infinity, name: 'GOAT', icon: '🐐' }
    };

    const currentTier = LEVEL_THRESHOLDS[user.current_level];
    const nextTier = user.current_level < 10 ? LEVEL_THRESHOLDS[user.current_level + 1] : null;
    
    const pointsToNext = nextTier ? nextTier.min - user.level_points : 0;
    const progressPercent = Math.round(
      ((user.level_points - currentTier.min) / (currentTier.max - currentTier.min)) * 100
    );

    const response = {
      level: user.current_level,
      levelName: currentTier.name,
      levelIcon: currentTier.icon,
      points: user.level_points,
      pointsToNext,
      progressPercent: Math.min(100, Math.max(0, progressPercent)),
      isMaxLevel: user.current_level === 10,
      nextLevel: nextTier ? {
        level: user.current_level + 1,
        name: nextTier.name,
        icon: nextTier.icon,
        requiredPoints: nextTier.min
      } : null,
      updatedAt: user.level_updated_at,
      calculationCount: user.level_calculation_count,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        avatar: user.avatar_base64
      }
    };

    // Cache for 5 minutes
    cache.set(cacheKey, response, TTL.SHORT);
    logLevelFetch(userId, response, 'api');

    res.json(response);
  } catch (error) {
    log.error('Get user level error', {
      userId: req.params.id,
      error: error.message
    });
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/level/user/:id/history
// Get level progression history (last 50 changes)
// ============================================================================
router.get('/user/:id/history', validateId('id'), async (req, res) => {
  try {
    const userId = req.params.id;
    const isOwn = req.user?.id == userId;
    const limit = isOwn ? 100 : 20; // Owner sees more history

    const result = await db.query(`
      SELECT 
        id,
        user_id,
        old_level,
        new_level,
        old_points,
        new_points,
        trigger_type,
        trick_id,
        stance,
        created_at
      FROM user_level_audit
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);

    res.json({
      userId,
      historyCount: result.rows.length,
      history: result.rows.map(row => ({
        oldLevel: row.old_level,
        newLevel: row.new_level,
        oldPoints: row.old_points,
        newPoints: row.new_points,
        pointsGain: row.new_points - row.old_points,
        triggerType: row.trigger_type,
        trickId: row.trick_id,
        stance: row.stance,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    log.error('Get level history error', {
      userId: req.params.id,
      error: error.message
    });
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/level/stats/:id
// Get user stats INCLUDING level (updated endpoint)
// ============================================================================
router.get('/stats/:id', validateId('id'), async (req, res) => {
  try {
    const userId = req.params.id;
    const cacheKey = `user:${userId}:stats`;
    
    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Tricks stats
    const tricksResult = await db.query(`
      SELECT 
        (COUNT(*) FILTER (WHERE status = $2) + COUNT(*) FILTER (WHERE COALESCE(goofy_status, '${STATUS.TODO}') = $2)) as mastered,
        (COUNT(*) FILTER (WHERE status = $3) + COUNT(*) FILTER (WHERE COALESCE(goofy_status, '${STATUS.TODO}') = $3)) as in_progress,
        COUNT(*) as total
      FROM user_tricks WHERE user_id = $1
    `, [userId, STATUS.MASTERED, STATUS.IN_PROGRESS]);
    
    // Articles stats
    let articlesResult = { rows: [{ known: 0, to_read: 0 }] };
    try {
      articlesResult = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = $2) as known,
          COUNT(*) FILTER (WHERE status = $3) as to_read
        FROM user_articles WHERE user_id = $1
      `, [userId, STATUS.KNOWN, STATUS.TO_READ]);
    } catch (e) { 
      log.warn('Article stats query failed', { userId, error: e.message }); 
    }
    
    // Events stats
    const eventsResult = await db.query(`
      SELECT COUNT(*) as events_attended
      FROM event_attendees WHERE user_id = $1
    `, [userId]);
    
    // Bookings stats
    let bookingsCount = 0;
    try {
      const bookingsResult = await db.query(`
        SELECT COUNT(*) as count
        FROM orders WHERE user_id = $1 AND booking_date IS NOT NULL
      `, [userId]);
      bookingsCount = parseInt(bookingsResult.rows[0]?.count) || 0;
    } catch (e) { 
      log.warn('Bookings stats query failed', { userId, error: e.message }); 
    }
    
    // LEVEL STATS - NEW
    const levelResult = await db.query(`
      SELECT 
        current_level,
        level_points,
        level_updated_at,
        level_calculation_count
      FROM users WHERE id = $1
    `, [userId]);

    const levelData = levelResult.rows[0] || { 
      current_level: 1, 
      level_points: 0,
      level_updated_at: null,
      level_calculation_count: 0
    };

    const response = {
      tricks: {
        mastered: parseInt(tricksResult.rows[0]?.mastered) || 0,
        inProgress: parseInt(tricksResult.rows[0]?.in_progress) || 0,
        total: parseInt(tricksResult.rows[0]?.total) || 0
      },
      articles: {
        read: parseInt(articlesResult.rows[0]?.known) || 0,
        toRead: parseInt(articlesResult.rows[0]?.to_read) || 0
      },
      events: parseInt(eventsResult.rows[0]?.events_attended) || 0,
      bookings: bookingsCount,
      level: {
        current: levelData.current_level,
        points: levelData.level_points,
        updatedAt: levelData.level_updated_at,
        calculationCount: levelData.level_calculation_count
      }
    };

    // Cache for 5 minutes
    cache.set(cacheKey, response, TTL.SHORT);

    res.json(response);
  } catch (error) {
    log.error('Get user stats error', { 
      userId: req.params.id,
      error: error.message 
    });
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/level/leaderboard
// Get top users by level and points
// Public endpoint
// ============================================================================
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const cacheKey = `leaderboard:levels:${limit}`;
    
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await db.query(`
      SELECT 
        u.id,
        u.public_id,
        u.username,
        u.display_name,
        u.avatar_base64,
        u.current_level,
        u.level_points,
        u.level_updated_at,
        COUNT(ut.id) FILTER (WHERE ut.status = '${STATUS.MASTERED}') as tricks_mastered
      FROM users u
      LEFT JOIN user_tricks ut ON u.id = ut.user_id
      WHERE u.is_public = true AND u.is_blocked = false
      GROUP BY u.id
      ORDER BY u.current_level DESC, u.level_points DESC
      LIMIT $1
    `, [limit]);

    const response = {
      count: result.rows.length,
      leaderboard: result.rows.map((row, idx) => ({
        rank: idx + 1,
        user: {
          id: row.id,
          publicId: row.public_id,
          username: row.username,
          displayName: row.display_name,
          avatar: row.avatar_base64
        },
        level: row.current_level,
        points: row.level_points,
        tricksMastered: parseInt(row.tricks_mastered) || 0,
        updatedAt: row.level_updated_at
      }))
    };

    logLeaderboardCalculation(result.rows.length, result.rows[0]);

    // Cache for 10 minutes
    cache.set(cacheKey, response, TTL.LONG);

    res.json(response);
  } catch (error) {
    log.error('Get level leaderboard error', { error: error.message });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
