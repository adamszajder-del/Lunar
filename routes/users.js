// Users Routes - /api/users/*
// Fixes applied: #1 atomic toggles, #5 consolidated achievements, #8 snake_case,
//                #12 deduplicated reactions, #17 ID validation, #19 structured logging
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { validateId } = require('../middleware/validateId');
const { sanitizeEmail, sanitizeString, validatePassword } = require('../utils/validators');
const { atomicToggleLike, getBatchReactions, getSingleReactions } = require('../utils/reactions');
const { STATUS, ITEM_TYPE } = require('../utils/constants');
const { cache } = require('../utils/cache');
const log = require('../utils/logger');

// Achievement definitions - single source of truth from achievements.js (#5)
const { ACHIEVEMENTS: ACH_DEFS, calculateUserAchievements, determineTier } = require('./achievements');
const ACHIEVEMENTS = ACH_DEFS;

// ============================================================================
// CREW & FAVORITES
// ============================================================================

// ============================================================================
// AVATAR — Serve user avatars as cacheable images (Fix PERF-1)
// Replaces inline avatar_base64 in lists (crew/friends/fans)
// Frontend: <img src="/api/users/:id/avatar" loading="lazy" />
// ============================================================================
const avatarImageCache = new Map();
const AVATAR_IMAGE_CACHE_TTL = 15 * 60 * 1000; // 15 min

// Cleanup every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of avatarImageCache) {
    if (now - v.ts > AVATAR_IMAGE_CACHE_TTL) avatarImageCache.delete(k);
  }
}, 10 * 60 * 1000);

router.get('/:id/avatar', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Memory cache hit
    const cached = avatarImageCache.get(userId);
    if (cached && Date.now() - cached.ts < AVATAR_IMAGE_CACHE_TTL) {
      res.setHeader('Content-Type', cached.mime);
      res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=1800');
      return res.send(cached.buffer);
    }

    const result = await db.query(
      'SELECT avatar_base64 FROM users WHERE id = $1', [userId]
    );

    if (!result.rows[0]?.avatar_base64) {
      // No avatar — redirect to default (browser caches redirect too)
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(204).end();
    }

    const raw = result.rows[0].avatar_base64;
    const commaIdx = raw.indexOf(',');
    if (commaIdx === -1) {
      return res.status(204).end();
    }

    const header = raw.substring(0, commaIdx);
    const mimeMatch = header.match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const buffer = Buffer.from(raw.substring(commaIdx + 1), 'base64');

    avatarImageCache.set(userId, { buffer, mime, ts: Date.now() });

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=1800');
    res.send(buffer);
  } catch (error) {
    log.error('Get avatar error', { error, userId: req.params.id });
    res.status(500).end();
  }
});

// Invalidate avatar cache when user changes avatar
const invalidateAvatarCache = (userId) => {
  avatarImageCache.delete(String(userId));
};

// ============================================================================
// CREW — Lightweight listing + lazy detail loading
// ============================================================================

// Get crew cards (lightweight — no avatar_base64, no stats JOINs)
router.get('/crew', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));
    const offset = parseInt(req.query.offset) || 0;

    const result = await db.query(`
      SELECT 
        u.id, u.public_id, u.username, u.display_name, u.created_at,
        COALESCE(u.is_coach, false) as is_coach, 
        COALESCE(u.is_staff, false) as is_staff,
        COALESCE(u.is_club_member, false) as is_club_member,
        u.role
      FROM users u
      WHERE (u.is_approved = true OR u.is_approved IS NULL) AND u.is_admin = false
      ORDER BY u.is_coach DESC NULLS LAST, u.username
      LIMIT $1 OFFSET $2
    `, [limit + 1, offset]);

    const hasMore = result.rows.length > limit;
    res.json({ items: result.rows.slice(0, limit), hasMore });
  } catch (error) {
    log.error('Get crew error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Search crew members (searches across full DB)
router.get('/crew/search', async (req, res) => {
  try {
    const q = sanitizeString(req.query.q || '', 100).trim();
    if (q.length < 2) {
      return res.json({ items: [] });
    }

    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 15));
    const searchTerm = `%${q}%`;

    const result = await db.query(`
      SELECT 
        u.id, u.public_id, u.username, u.display_name,
        COALESCE(u.is_coach, false) as is_coach, 
        COALESCE(u.is_staff, false) as is_staff,
        COALESCE(u.is_club_member, false) as is_club_member,
        u.role
      FROM users u
      WHERE (u.is_approved = true OR u.is_approved IS NULL) AND u.is_admin = false
        AND (u.username ILIKE $1 OR u.display_name ILIKE $1)
      ORDER BY 
        CASE WHEN u.username ILIKE $2 THEN 0 ELSE 1 END,
        u.username
      LIMIT $3
    `, [searchTerm, q + '%', limit]);

    res.json({ items: result.rows });
  } catch (error) {
    log.error('Search crew error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get crew member full detail (stats, loaded on tap)
router.get('/crew/:id/detail', validateId('id'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const [userRes, statsRes, followersRes, followingRes] = await Promise.all([
      db.query(`
        SELECT id, public_id, username, display_name, avatar_base64, created_at,
          COALESCE(is_coach, false) as is_coach, 
          COALESCE(is_staff, false) as is_staff,
          COALESCE(is_club_member, false) as is_club_member,
          role
        FROM users WHERE id = $1
      `, [userId]),
      db.query(`
        SELECT 
          COALESCE(SUM(CASE WHEN status = $2 THEN 1 ELSE 0 END) + SUM(CASE WHEN COALESCE(goofy_status, 'todo') = $2 THEN 1 ELSE 0 END), 0) as mastered,
          COALESCE(SUM(CASE WHEN status = $3 THEN 1 ELSE 0 END) + SUM(CASE WHEN COALESCE(goofy_status, 'todo') = $3 THEN 1 ELSE 0 END), 0) as in_progress
        FROM user_tricks WHERE user_id = $1
      `, [userId, STATUS.MASTERED, STATUS.IN_PROGRESS]),
      db.query('SELECT COUNT(*) as count FROM favorites WHERE item_type = $1 AND item_id = $2', [ITEM_TYPE.USER, userId]),
      db.query('SELECT COUNT(*) as count FROM favorites WHERE item_type = $1 AND user_id = $2', [ITEM_TYPE.USER, userId]),
    ]);

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      ...userRes.rows[0],
      stats: {
        mastered: parseInt(statsRes.rows[0]?.mastered) || 0,
        in_progress: parseInt(statsRes.rows[0]?.in_progress) || 0,
      },
      followers_count: parseInt(followersRes.rows[0]?.count) || 0,
      following_count: parseInt(followingRes.rows[0]?.count) || 0,
    });
  } catch (error) {
    log.error('Get crew detail error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's favorites (IDs only — for UI state: hearts, follow buttons)
router.get('/favorites', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT item_type, item_id FROM favorites WHERE user_id = $1',
      [req.user.id]
    );
    
    const favorites = result.rows;
    
    const response = {
      tricks: favorites.filter(f => f.item_type === ITEM_TYPE.TRICK).map(f => f.item_id),
      articles: favorites.filter(f => f.item_type === ITEM_TYPE.ARTICLE).map(f => f.item_id),
      users: favorites.filter(f => f.item_type === ITEM_TYPE.USER).map(f => f.item_id)
    };
    
    res.json(response);
  } catch (err) {
    log.error('Get favorites error', { error: err });
    res.status(500).json({ error: 'Failed to get favorites' });
  }
});

// Toggle favorite — Fix #1: atomic toggle
router.post('/favorites', authMiddleware, async (req, res) => {
  try {
    const { item_type, item_id } = req.body;
    
    if (!Object.values(ITEM_TYPE).includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    
    // Atomic: try DELETE first, if nothing deleted then INSERT
    const deleted = await db.query(
      'DELETE FROM favorites WHERE user_id = $1 AND item_type = $2 AND item_id = $3 RETURNING id',
      [req.user.id, item_type, item_id]
    );
    
    if (deleted.rows.length > 0) {
      res.json({ isFavorite: false });
    } else {
      await db.query(
        'INSERT INTO favorites (user_id, item_type, item_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [req.user.id, item_type, item_id]
      );
      res.json({ isFavorite: true });
    }
  } catch (err) {
    log.error('Toggle favorite error', { error: err });
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// Get my friends (users I follow) — paginated cards
router.get('/me/friends', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 15);
    const offset = parseInt(req.query.offset) || 0;

    const result = await db.query(`
      SELECT u.id, u.public_id, u.username, u.display_name,
        COALESCE(u.is_coach, false) as is_coach, 
        COALESCE(u.is_staff, false) as is_staff,
        COALESCE(u.is_club_member, false) as is_club_member,
        u.role
      FROM favorites f
      JOIN users u ON f.item_id = u.id
      WHERE f.user_id = $1 AND f.item_type = $2
      ORDER BY f.created_at DESC
      LIMIT $3 OFFSET $4
    `, [req.user.id, ITEM_TYPE.USER, limit + 1, offset]);

    const hasMore = result.rows.length > limit;
    res.json({ items: result.rows.slice(0, limit), hasMore });
  } catch (err) {
    log.error('Get friends error', { error: err });
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

// Get my followers (users who follow ME) — paginated cards
router.get('/me/followers', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 15);
    const offset = parseInt(req.query.offset) || 0;

    const result = await db.query(`
      SELECT u.id, u.public_id, u.username, u.display_name,
        COALESCE(u.is_coach, false) as is_coach, 
        COALESCE(u.is_staff, false) as is_staff,
        COALESCE(u.is_club_member, false) as is_club_member,
        u.role
      FROM favorites f
      JOIN users u ON f.user_id = u.id
      WHERE f.item_type = $1 AND f.item_id = $2
      ORDER BY f.created_at DESC
      LIMIT $3 OFFSET $4
    `, [ITEM_TYPE.USER, req.user.id, limit + 1, offset]);

    const hasMore = result.rows.length > limit;
    res.json({ items: result.rows.slice(0, limit), hasMore });
  } catch (err) {
    log.error('Get followers error', { error: err });
    res.status(500).json({ error: 'Failed to get followers' });
  }
});

// Update user profile
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const email = req.body.email ? sanitizeEmail(req.body.email) : null;
    const password = req.body.password;
    const userId = req.user.id;

    if (password) {
      const passwordCheck = validatePassword(password);
      if (!passwordCheck.valid) {
        return res.status(400).json({ 
          error: passwordCheck.errors[0],
          errors: passwordCheck.errors,
          code: 'WEAK_PASSWORD'
        });
      }
    }

    if (email) {
      const existing = await db.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, userId]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    let query, params;
    
    if (password) {
      const passwordHash = await bcrypt.hash(password, 12);
      if (email) {
        query = 'UPDATE users SET email = $1, password_hash = $2 WHERE id = $3 RETURNING id, email, username';
        params = [email, passwordHash, userId];
      } else {
        query = 'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email, username';
        params = [passwordHash, userId];
      }
    } else if (email) {
      query = 'UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email, username';
      params = [email, userId];
    } else {
      return res.status(400).json({ error: 'No changes provided' });
    }

    const result = await db.query(query, params);
    res.json(result.rows[0]);
  } catch (error) {
    log.error('Update profile error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user avatar — rate limited: 1 change per 2 hours
const avatarCooldowns = new Map();
const AVATAR_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup stale cooldowns every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [uid, ts] of avatarCooldowns) {
    if (now - ts > AVATAR_COOLDOWN_MS) avatarCooldowns.delete(uid);
  }
}, 30 * 60 * 1000);

router.put('/me/avatar', authMiddleware, express.json({ limit: '200kb' }), async (req, res) => {
  try {
    // Check cooldown (admins bypass)
    if (!req.user.is_admin) {
      const lastChange = avatarCooldowns.get(req.user.id);
      if (lastChange) {
        const elapsed = Date.now() - lastChange;
        if (elapsed < AVATAR_COOLDOWN_MS) {
          const remaining = Math.ceil((AVATAR_COOLDOWN_MS - elapsed) / 60000);
          return res.status(429).json({ 
            error: `You can change your avatar again in ${remaining} minutes`,
            retryAfter: Math.ceil((AVATAR_COOLDOWN_MS - elapsed) / 1000)
          });
        }
      }
    }

    const { avatar_base64 } = req.body;
    
    if (!avatar_base64) {
      return res.status(400).json({ error: 'Avatar data required' });
    }

    const allowedPrefixes = [
      'data:image/jpeg;base64,',
      'data:image/jpg;base64,',
      'data:image/png;base64,',
      'data:image/webp;base64,'
    ];
    if (!allowedPrefixes.some(p => avatar_base64.startsWith(p))) {
      return res.status(400).json({ error: 'Only JPEG, PNG, or WebP images allowed' });
    }

    if (avatar_base64.length > 100000) {
      return res.status(400).json({ error: 'Avatar too large (max ~75KB)' });
    }

    await db.query(
      'UPDATE users SET avatar_base64 = $1 WHERE id = $2',
      [avatar_base64, req.user.id]
    );
    avatarCooldowns.set(req.user.id, Date.now());
    invalidateAvatarCache(req.user.id);
    cache.invalidate('crew:all');
    res.json({ success: true });
  } catch (error) {
    log.error('Update avatar error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// ACHIEVEMENTS — Fix #5: uses consolidated calculateUserAchievements from achievements.js
// ============================================================================

// Get user achievements by ID
router.get('/:id/achievements', validateId('id'), async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Fix #5: use single calculateUserAchievements from achievements.js
    const progress = await calculateUserAchievements(userId);
    
    // Get stored achievements
    const storedResult = await db.query(
      'SELECT achievement_id, tier, achieved_at FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    
    const stored = {};
    storedResult.rows.forEach(row => {
      stored[row.achievement_id] = { tier: row.tier, achieved_at: row.achieved_at };
    });
    
    // Get manual achievements
    let manualResult = { rows: [] };
    try {
      manualResult = await db.query(
        'SELECT achievement_id, awarded_at FROM user_manual_achievements WHERE user_id = $1',
        [userId]
      );
    } catch (e) { log.warn('Manual achievements table missing', { error: e.message }); }
    
    const manual = {};
    manualResult.rows.forEach(row => {
      manual[row.achievement_id] = { achieved_at: row.awarded_at };
    });
    
    // Build response
    const achievements = [];
    for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
      if (def.type === 'manual') {
        achievements.push({
          id,
          ...def,
          achieved: !!manual[id],
          currentTier: manual[id] ? STATUS.SPECIAL : null,
          tier: manual[id] ? STATUS.SPECIAL : null,
          progress: manual[id] ? 1 : 0,
          achieved_at: manual[id]?.achieved_at || null
        });
      } else {
        const currentValue = progress[id] || 0;
        const currentTier = determineTier(currentValue, def.tiers);
        
        achievements.push({
          id,
          ...def,
          achieved: !!currentTier,
          currentTier: stored[id]?.tier || currentTier,
          tier: stored[id]?.tier || currentTier,
          progress: currentValue,
          achieved_at: stored[id]?.achieved_at || null
        });
      }
    }
    
    res.json(achievements);
  } catch (error) {
    log.error('Get user achievements error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user stats by ID
router.get('/:id/stats', validateId('id'), async (req, res) => {
  try {
    const userId = req.params.id;
    
    const tricksResult = await db.query(`
      SELECT 
        (COUNT(*) FILTER (WHERE status = $2) + COUNT(*) FILTER (WHERE COALESCE(goofy_status, 'todo') = $2)) as mastered,
        (COUNT(*) FILTER (WHERE status = $3) + COUNT(*) FILTER (WHERE COALESCE(goofy_status, 'todo') = $3)) as in_progress,
        COUNT(*) as total
      FROM user_tricks WHERE user_id = $1
    `, [userId, STATUS.MASTERED, STATUS.IN_PROGRESS]);
    
    let articlesResult = { rows: [{ known: 0, to_read: 0 }] };
    try {
      articlesResult = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = $2) as known,
          COUNT(*) FILTER (WHERE status = $3) as to_read
        FROM user_articles WHERE user_id = $1
      `, [userId, STATUS.KNOWN, STATUS.TO_READ]);
    } catch (e) { log.warn('Article stats query failed', { error: e.message }); }
    
    const eventsResult = await db.query(`
      SELECT COUNT(*) as events_attended
      FROM event_attendees WHERE user_id = $1
    `, [userId]);
    
    let bookingsCount = 0;
    try {
      const bookingsResult = await db.query(`
        SELECT COUNT(*) as count
        FROM orders WHERE user_id = $1 AND booking_date IS NOT NULL
      `, [userId]);
      bookingsCount = parseInt(bookingsResult.rows[0]?.count) || 0;
    } catch (e) { log.warn('Bookings stats query failed', { error: e.message }); }
    
    res.json({
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
      bookings: bookingsCount
    });
  } catch (error) {
    log.error('Get user stats error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's tricks by ID
router.get('/:id/tricks', validateId('id'), async (req, res) => {
  try {
    const userId = req.params.id;
    
    const result = await db.query(`
      SELECT ut.id, ut.trick_id, ut.status, COALESCE(ut.goofy_status, 'todo') as goofy_status, ut.updated_at,
             t.name, t.category, t.difficulty
      FROM user_tricks ut
      JOIN tricks t ON ut.trick_id = t.id
      WHERE ut.user_id = $1
      ORDER BY t.category, t.name
    `, [userId]);
    
    res.json(result.rows);
  } catch (error) {
    log.error('Get user tricks error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// TRICK REACTIONS — Fix #12: uses shared getBatchReactions helper
// ============================================================================

// Get reactions for all user's mastered tricks — Fix #4 + #12: batch query instead of N+1 loop
router.get('/:id/tricks/reactions', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const viewerId = req.user.id;
    
    // Get all mastered tricks for this user
    const tricksResult = await db.query(
      `SELECT trick_id FROM user_tricks WHERE user_id = $1 AND (status = $2 OR COALESCE(goofy_status, 'todo') = $2)`,
      [ownerId, STATUS.MASTERED]
    );
    
    const trickIds = tricksResult.rows.map(r => r.trick_id);
    
    if (trickIds.length === 0) return res.json([]);
    
    // Fix #12: single batch call replaces ~700 queries
    const reactions = await getBatchReactions({
      likesTable: 'trick_likes',
      likesOwnerCol: 'owner_id',
      likesItemCol: 'trick_id',
      likesUserCol: 'liker_id',
      commentsTable: 'trick_comments',
      commentsOwnerCol: 'owner_id',
      commentsItemCol: 'trick_id',
      commentLikesTable: 'comment_likes',
      ownerId: parseInt(ownerId),
      viewerId,
      itemIds: trickIds,
      itemIdField: 'trick_id',
    });
    
    res.json(reactions);
  } catch (error) {
    log.error('Get trick reactions error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on a trick — Fix #1: atomic toggle
router.post('/:id/tricks/:trickId/like', validateId('id', 'trickId'), authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const trickId = parseInt(req.params.trickId);
    const likerId = req.user.id;
    
    const { userLiked, likesCount } = await atomicToggleLike(
      'trick_likes',
      { owner_id: ownerId, trick_id: trickId, liker_id: likerId },
      { owner_id: ownerId, trick_id: trickId }
    );
    
    // Create notification only on like (not unlike)
    if (userLiked) {
      const trickName = await db.query('SELECT name FROM tricks WHERE id = $1', [trickId]);
      await createNotification(ownerId, 'trick_like', likerId, 'trick', trickId, trickName.rows[0]?.name);
    }
    
    res.json({ likes_count: likesCount, user_liked: userLiked });
  } catch (error) {
    log.error('Toggle like error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to a trick
router.post('/:id/tricks/:trickId/comment', validateId('id', 'trickId'), authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const trickId = parseInt(req.params.trickId);
    const authorId = req.user.id;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    const safeContent = sanitizeString(content, 1000);
    if (!safeContent) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const result = await db.query(`
      INSERT INTO trick_comments (owner_id, trick_id, author_id, content)
      VALUES ($1, $2, $3, $4)
      RETURNING id, content, created_at
    `, [ownerId, trickId, authorId, safeContent]);
    
    const authorResult = await db.query(
      'SELECT username, avatar_base64 FROM users WHERE id = $1',
      [authorId]
    );
    
    const trickName = await db.query('SELECT name FROM tricks WHERE id = $1', [trickId]);
    await createNotification(ownerId, 'trick_comment', authorId, 'trick', trickId, trickName.rows[0]?.name);
    
    res.json({
      id: result.rows[0].id,
      content: result.rows[0].content,
      created_at: result.rows[0].created_at,
      author_id: authorId,
      author_username: authorResult.rows[0]?.username,
      author_avatar: authorResult.rows[0]?.avatar_base64,
      likes_count: 0,
      user_liked: false
    });
  } catch (error) {
    log.error('Add comment error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get comments for a specific trick — Fix #12: batch comment likes
router.get('/:id/tricks/:trickId/comments', validateId('id', 'trickId'), authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const trickId = parseInt(req.params.trickId);
    const viewerId = req.user.id;
    
    const result = await db.query(`
      SELECT 
        tc.id, tc.content, tc.created_at, tc.author_id,
        u.username as author_username, u.avatar_base64 as author_avatar
      FROM trick_comments tc
      JOIN users u ON tc.author_id = u.id
      WHERE tc.owner_id = $1 AND tc.trick_id = $2
        AND (tc.is_deleted IS NULL OR tc.is_deleted = false)
      ORDER BY tc.created_at ASC
    `, [ownerId, trickId]);
    
    // Batch get comment likes instead of N+1 loop
    const commentIds = result.rows.map(c => c.id);
    let commentLikesMap = {};
    
    if (commentIds.length > 0) {
      const clResult = await db.query(`
        SELECT comment_id, COUNT(*) as count, BOOL_OR(user_id = $1) as user_liked
        FROM comment_likes WHERE comment_id = ANY($2)
        GROUP BY comment_id
      `, [viewerId, commentIds]);
      
      clResult.rows.forEach(r => {
        commentLikesMap[r.comment_id] = { likes_count: parseInt(r.count), user_liked: r.user_liked };
      });
    }
    
    const comments = result.rows.map(comment => {
      const cl = commentLikesMap[comment.id] || { likes_count: 0, user_liked: false };
      return {
        ...comment,
        user_id: comment.author_id,
        username: comment.author_username,
        display_name: comment.author_username,
        avatar_base64: comment.author_avatar,
        likes_count: cl.likes_count,
        user_liked: cl.user_liked,
      };
    });
    
    res.json(comments);
  } catch (error) {
    log.error('Get trick comments error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on a comment — Fix #1: atomic toggle
router.post('/:id/tricks/:trickId/comments/:commentId/like', validateId('id', 'trickId', 'commentId'), authMiddleware, async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const userId = req.user.id;
    
    const { userLiked, likesCount } = await atomicToggleLike(
      'comment_likes',
      { comment_id: commentId, user_id: userId },
      { comment_id: commentId }
    );
    
    if (userLiked) {
      const comment = await db.query('SELECT author_id FROM trick_comments WHERE id = $1', [commentId]);
      if (comment.rows[0]) {
        await createNotification(comment.rows[0].author_id, 'comment_like', userId, 'comment', commentId, null);
      }
    }
    
    res.json({ likes_count: likesCount, user_liked: userLiked });
  } catch (error) {
    log.error('Toggle comment like error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a comment (only author can delete)
router.delete('/:id/tricks/:trickId/comments/:commentId', validateId('id', 'trickId', 'commentId'), authMiddleware, async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const userId = req.user.id;
    
    const comment = await db.query('SELECT author_id FROM trick_comments WHERE id = $1', [commentId]);
    if (comment.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    if (comment.rows[0].author_id !== userId) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    
    await db.query('DELETE FROM trick_comments WHERE id = $1', [commentId]);
    res.json({ success: true });
  } catch (error) {
    log.error('Delete comment error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// ACHIEVEMENT REACTIONS — Fix #12: uses shared helpers
// ============================================================================

// Get reactions for user's achievements — batch query
router.get('/:id/achievements/reactions', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const viewerId = req.user.id;
    
    const achievementsResult = await db.query(
      'SELECT achievement_id FROM user_achievements WHERE user_id = $1',
      [ownerId]
    );
    
    const achievementIds = achievementsResult.rows.map(r => r.achievement_id);
    if (achievementIds.length === 0) return res.json([]);
    
    const reactions = await getBatchReactions({
      likesTable: 'achievement_likes',
      likesOwnerCol: 'owner_id',
      likesItemCol: 'achievement_id',
      likesUserCol: 'liker_id',
      commentsTable: 'achievement_comments',
      commentsOwnerCol: 'owner_id',
      commentsItemCol: 'achievement_id',
      commentLikesTable: 'achievement_comment_likes',
      ownerId,
      viewerId,
      itemIds: achievementIds,
      itemIdField: 'achievement_id',
    });
    
    res.json(reactions);
  } catch (error) {
    log.error('Get achievement reactions error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get reactions for a single achievement — Fix #8: standardized to snake_case
router.get('/:id/achievements/:achievementId/reactions', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const achievementId = req.params.achievementId;
    const viewerId = req.user.id;
    
    const result = await getSingleReactions({
      likesTable: 'achievement_likes',
      likesOwnerCol: 'owner_id',
      likesItemCol: 'achievement_id',
      likesUserCol: 'liker_id',
      commentsTable: 'achievement_comments',
      commentsOwnerCol: 'owner_id',
      commentsItemCol: 'achievement_id',
      commentLikesTable: 'achievement_comment_likes',
      ownerId,
      viewerId,
      itemId: achievementId,
      itemIdField: 'achievement_id',
    });
    
    // Fix #8: keep backward compatible — return both snake_case and camelCase
    res.json({
      likes_count: result.likes_count,
      comments_count: result.comments_count,
      user_liked: result.user_liked,
      // backward compat for existing frontend
      likesCount: result.likes_count,
      commentsCount: result.comments_count,
      userLiked: result.user_liked,
      comments: result.comments,
    });
  } catch (error) {
    log.error('Get single achievement reactions error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on an achievement — Fix #1: atomic toggle
router.post('/:id/achievements/:achievementId/like', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const achievementId = req.params.achievementId;
    const likerId = req.user.id;
    
    const { userLiked, likesCount } = await atomicToggleLike(
      'achievement_likes',
      { owner_id: ownerId, achievement_id: achievementId, liker_id: likerId },
      { owner_id: ownerId, achievement_id: achievementId }
    );
    
    if (userLiked) {
      await createNotification(ownerId, 'achievement_like', likerId, 'achievement', null, achievementId);
    }
    
    res.json({ likes_count: likesCount, user_liked: userLiked });
  } catch (error) {
    log.error('Toggle achievement like error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to an achievement
router.post('/:id/achievements/:achievementId/comment', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id);
    const achievementId = req.params.achievementId;
    const authorId = req.user.id;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const safeContent = sanitizeString(content, 1000);
    if (!safeContent) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const result = await db.query(`
      INSERT INTO achievement_comments (owner_id, achievement_id, author_id, content)
      VALUES ($1, $2, $3, $4)
      RETURNING id, content, created_at
    `, [ownerId, achievementId, authorId, safeContent]);
    
    const authorResult = await db.query('SELECT username, avatar_base64 FROM users WHERE id = $1', [authorId]);
    
    await createNotification(ownerId, 'achievement_comment', authorId, 'achievement', null, achievementId);
    
    res.json({
      id: result.rows[0].id,
      content: result.rows[0].content,
      created_at: result.rows[0].created_at,
      author_id: authorId,
      author_username: authorResult.rows[0]?.username,
      author_avatar: authorResult.rows[0]?.avatar_base64,
      likes_count: 0,
      user_liked: false
    });
  } catch (error) {
    log.error('Add achievement comment error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on achievement comment — Fix #1: atomic toggle
router.post('/:id/achievements/:achievementId/comments/:commentId/like', validateId('id', 'commentId'), authMiddleware, async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const userId = req.user.id;
    
    const { userLiked, likesCount } = await atomicToggleLike(
      'achievement_comment_likes',
      { comment_id: commentId, user_id: userId },
      { comment_id: commentId }
    );
    
    if (userLiked) {
      const comment = await db.query('SELECT author_id FROM achievement_comments WHERE id = $1', [commentId]);
      if (comment.rows[0]) {
        await createNotification(comment.rows[0].author_id, 'comment_like', userId, 'comment', commentId, null);
      }
    }
    
    res.json({ likes_count: likesCount, user_liked: userLiked });
  } catch (error) {
    log.error('Toggle achievement comment like error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete achievement comment (only author can delete)
router.delete('/:id/achievements/:achievementId/comments/:commentId', validateId('id', 'commentId'), authMiddleware, async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const userId = req.user.id;
    
    const comment = await db.query('SELECT author_id FROM achievement_comments WHERE id = $1', [commentId]);
    if (comment.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    if (comment.rows[0].author_id !== userId) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    
    await db.query('DELETE FROM achievement_comments WHERE id = $1', [commentId]);
    res.json({ success: true });
  } catch (error) {
    log.error('Delete achievement comment error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// NOTIFICATIONS
// ============================================================================

// Helper: Create or update grouped notification
async function createNotification(userId, type, actorId, targetType, targetId, targetName) {
  if (userId === actorId) return; // Don't notify yourself
  
  try {
    const existing = await db.query(`
      SELECT id, count FROM notification_groups 
      WHERE user_id = $1 AND type = $2 AND target_type = $3 AND target_id = $4
    `, [userId, type, targetType, targetId]);
    
    if (existing.rows.length > 0) {
      await db.query(`
        UPDATE notification_groups 
        SET count = count + 1, last_actor_id = $1, is_read = false, updated_at = NOW()
        WHERE id = $2
      `, [actorId, existing.rows[0].id]);
    } else {
      await db.query(`
        INSERT INTO notification_groups (user_id, type, target_type, target_id, last_actor_id)
        VALUES ($1, $2, $3, $4, $5)
      `, [userId, type, targetType, targetId, actorId]);
    }
    
    await db.query(`
      INSERT INTO notifications (user_id, type, actor_id, target_type, target_id, target_name)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [userId, type, actorId, targetType, targetId, targetName]);
  } catch (e) {
    log.error('Create notification error', { error: e });
  }
}

// Helper: Notify followers about friend achievement/trick
async function notifyFollowers(userId, type, targetType, targetId, targetName) {
  try {
    const followers = await db.query(
      `SELECT user_id FROM favorites WHERE item_type = $1 AND item_id = $2`,
      [ITEM_TYPE.USER, userId]
    );
    
    // PERF: Fire all notifications in parallel instead of sequentially
    // 50 followers: ~100 sequential queries → ~2 parallel rounds
    await Promise.allSettled(
      followers.rows.map(follower => 
        createNotification(follower.user_id, type, userId, targetType, targetId, targetName)
      )
    );
  } catch (e) {
    log.error('Notify followers error', { error: e });
  }
}

// GET /api/notifications - Get user's notifications
router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(`
      SELECT 
        ng.id, ng.type, ng.target_type, ng.target_id, ng.count, ng.is_read, ng.created_at, ng.updated_at,
        u.id as actor_id, u.username as actor_username, u.avatar_base64 as actor_avatar,
        CASE 
          WHEN ng.target_type = 'trick' THEN (SELECT name FROM tricks WHERE id = ng.target_id)
          ELSE ng.target_id::TEXT
        END as target_name
      FROM notification_groups ng
      LEFT JOIN users u ON u.id = ng.last_actor_id
      WHERE ng.user_id = $1
      ORDER BY ng.updated_at DESC
      LIMIT 50
    `, [userId]);
    
    const unreadResult = await db.query(
      'SELECT COUNT(*) as count FROM notification_groups WHERE user_id = $1 AND is_read = false',
      [userId]
    );
    
    res.json({
      notifications: result.rows,
      unread_count: parseInt(unreadResult.rows[0].count) || 0
    });
  } catch (error) {
    log.error('Get notifications error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/notifications/count
router.get('/notifications/count', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT COUNT(*) as count FROM notification_groups WHERE user_id = $1 AND is_read = false',
      [req.user.id]
    );
    res.json({ unread_count: parseInt(result.rows[0].count) || 0 });
  } catch (error) {
    log.error('Get notification count error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/:id/read
router.post('/notifications/:id/read', validateId('id'), authMiddleware, async (req, res) => {
  try {
    await db.query(
      'UPDATE notification_groups SET is_read = true WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    log.error('Mark notification read error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/read-all
router.post('/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await db.query('UPDATE notification_groups SET is_read = true WHERE user_id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (error) {
    log.error('Mark all read error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/notifications/:id
router.delete('/notifications/:id', validateId('id'), authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM notification_groups WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (error) {
    log.error('Delete notification error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/notifications
router.delete('/notifications', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM notification_groups WHERE user_id = $1', [req.user.id]);
    await db.query('DELETE FROM notifications WHERE user_id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (error) {
    log.error('Delete all notifications error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/:id/activity — user's activity feed for profile History
router.get('/:id/activity', validateId('id'), authMiddleware, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.id);
    const viewerId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const query = `
      WITH trick_feed AS (
        SELECT 
          'trick_' || ut.status as type,
          ut.user_id,
          ut.trick_id,
          NULL::integer as event_id,
          NULL::text as achievement_id,
          COALESCE(ut.updated_at, NOW()) as created_at,
          json_build_object(
            'trick_id', t.id,
            'trick_name', t.name,
            'trick_category', t.category,
            'trick_difficulty', t.difficulty
          ) as data,
          COALESCE(likes.count, 0) as reactions_count,
          COALESCE(comments.count, 0) as comments_count
        FROM user_tricks ut
        JOIN tricks t ON ut.trick_id = t.id
        LEFT JOIN (
          SELECT owner_id, trick_id, COUNT(*) as count 
          FROM trick_likes GROUP BY owner_id, trick_id
        ) likes ON likes.owner_id = ut.user_id AND likes.trick_id = ut.trick_id
        LEFT JOIN (
          SELECT owner_id, trick_id, COUNT(*) as count 
          FROM trick_comments WHERE is_deleted IS NULL OR is_deleted = false
          GROUP BY owner_id, trick_id
        ) comments ON comments.owner_id = ut.user_id AND comments.trick_id = ut.trick_id
        WHERE ut.user_id = $1 AND (ut.status IN ('mastered', 'in_progress') OR COALESCE(ut.goofy_status, 'todo') IN ('mastered', 'in_progress'))
      ),
      event_feed AS (
        SELECT 
          'event_joined' as type,
          ea.user_id,
          NULL::integer as trick_id,
          ea.event_id,
          NULL::text as achievement_id,
          COALESCE(ea.registered_at, NOW()) as created_at,
          json_build_object(
            'event_id', e.id,
            'event_title', e.name,
            'event_date', e.date
          ) as data,
          0::bigint as reactions_count,
          0::bigint as comments_count
        FROM event_attendees ea
        JOIN events e ON ea.event_id = e.id
        WHERE ea.user_id = $1
      ),
      achievement_feed AS (
        SELECT 
          'achievement_earned' as type,
          ua.user_id,
          NULL::integer as trick_id,
          NULL::integer as event_id,
          ua.achievement_id,
          COALESCE(ua.achieved_at, NOW()) as created_at,
          json_build_object(
            'achievement_id', ua.achievement_id,
            'achievement_name', ua.achievement_id,
            'tier', ua.tier,
            'icon', ua.achievement_id
          ) as data,
          COALESCE(likes.count, 0) as reactions_count,
          COALESCE(comments.count, 0) as comments_count
        FROM user_achievements ua
        LEFT JOIN (
          SELECT owner_id, achievement_id, COUNT(*) as count 
          FROM achievement_likes GROUP BY owner_id, achievement_id
        ) likes ON likes.owner_id = ua.user_id AND likes.achievement_id = ua.achievement_id
        LEFT JOIN (
          SELECT owner_id, achievement_id, COUNT(*) as count 
          FROM achievement_comments WHERE is_deleted IS NULL OR is_deleted = false
          GROUP BY owner_id, achievement_id
        ) comments ON comments.owner_id = ua.user_id AND comments.achievement_id = ua.achievement_id
        WHERE ua.user_id = $1
      )
      SELECT * FROM (
        SELECT * FROM trick_feed
        UNION ALL
        SELECT * FROM event_feed
        UNION ALL
        SELECT * FROM achievement_feed
      ) combined
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2
    `;

    const result = await db.query(query, [targetUserId, limit]);

    // Enrich achievement names from definitions
    const items = result.rows.map(row => {
      let data = row.data;
      if (row.type === 'achievement_earned' && row.achievement_id && ACHIEVEMENTS[row.achievement_id]) {
        const achDef = ACHIEVEMENTS[row.achievement_id];
        data = { ...data, achievement_name: achDef.name, icon: achDef.icon, description: achDef.description };
      }
      // Normalize trick type
      let type = row.type;
      if (type === 'trick_mastered') type = 'trick_mastered';
      else if (type === 'trick_in_progress') type = 'trick_started';

      return {
        id: row.trick_id ? `${type}_${row.user_id}_${row.trick_id}`
           : row.event_id ? `${type}_${row.user_id}_${row.event_id}`
           : `${type}_${row.user_id}_${row.achievement_id}`,
        type,
        created_at: row.created_at,
        data,
        reactions_count: parseInt(row.reactions_count) || 0,
        comments_count: parseInt(row.comments_count) || 0
      };
    });

    res.json({ items });
  } catch (error) {
    log.error('Get user activity error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
