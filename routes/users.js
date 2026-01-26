// Users Routes - /api/users/*
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { sanitizeEmail } = require('../utils/validators');

// Achievement definitions for progress calculation
const ACHIEVEMENTS = {
  trick_master: { id: 'trick_master', name: 'Trick Master', icon: '🏆', type: 'tiered', tiers: { bronze: 5, silver: 15, gold: 30, diamond: 50 } },
  knowledge_seeker: { id: 'knowledge_seeker', name: 'Knowledge Seeker', icon: '📚', type: 'tiered', tiers: { bronze: 3, silver: 8, gold: 15, diamond: 30 } },
  event_enthusiast: { id: 'event_enthusiast', name: 'Event Enthusiast', icon: '📅', type: 'tiered', tiers: { bronze: 3, silver: 10, gold: 20, diamond: 30 } },
  loyal_customer: { id: 'loyal_customer', name: 'Loyal Customer', icon: '💜', type: 'tiered', tiers: { bronze: 3, silver: 10, gold: 25, diamond: 50 } },
  surface_pro: { id: 'surface_pro', name: 'Surface Pro', icon: '🌊', type: 'tiered', tiers: { bronze: 2, silver: 5, gold: 8, diamond: 10 } },
  air_master: { id: 'air_master', name: 'Air Master', icon: '🚀', type: 'tiered', tiers: { bronze: 2, silver: 5, gold: 8, diamond: 15 } },
  kicker_king: { id: 'kicker_king', name: 'Kicker King', icon: '⚡', type: 'tiered', tiers: { bronze: 2, silver: 5, gold: 8, diamond: 12 } },
  rail_rider: { id: 'rail_rider', name: 'Rail Rider', icon: '🛹', type: 'tiered', tiers: { bronze: 2, silver: 5, gold: 8, diamond: 12 } },
  profile_pro: { id: 'profile_pro', name: 'Profile Pro', icon: '📸', type: 'manual' },
  vip_guest: { id: 'vip_guest', name: 'VIP Guest', icon: '⭐', type: 'manual' },
  competition_winner: { id: 'competition_winner', name: 'Competition Winner', icon: '🥇', type: 'manual' }
};

function determineTier(value, tiers) {
  if (!tiers) return null;
  if (value >= tiers.diamond) return 'diamond';
  if (value >= tiers.gold) return 'gold';
  if (value >= tiers.silver) return 'silver';
  if (value >= tiers.bronze) return 'bronze';
  return null;
}

async function calculateUserAchievementsForUser(userId) {
  const progress = {};
  
  try {
    // Trick stats
    const tricksResult = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'mastered') as total_mastered,
        COUNT(*) FILTER (WHERE status = 'mastered' AND t.category = 'surface') as surface,
        COUNT(*) FILTER (WHERE status = 'mastered' AND t.category = 'air') as air,
        COUNT(*) FILTER (WHERE status = 'mastered' AND t.category = 'kicker') as kicker,
        COUNT(*) FILTER (WHERE status = 'mastered' AND t.category = 'rail') as rail
      FROM user_tricks ut
      JOIN tricks t ON ut.trick_id = t.id
      WHERE ut.user_id = $1
    `, [userId]);
    
    progress.trick_master = parseInt(tricksResult.rows[0]?.total_mastered) || 0;
    progress.surface_pro = parseInt(tricksResult.rows[0]?.surface) || 0;
    progress.air_master = parseInt(tricksResult.rows[0]?.air) || 0;
    progress.kicker_king = parseInt(tricksResult.rows[0]?.kicker) || 0;
    progress.rail_rider = parseInt(tricksResult.rows[0]?.rail) || 0;
  } catch (e) { /* ignore */ }
  
  try {
    // Articles
    const articlesResult = await db.query(
      `SELECT COUNT(*) as count FROM user_articles WHERE user_id = $1 AND status = 'known'`,
      [userId]
    );
    progress.knowledge_seeker = parseInt(articlesResult.rows[0]?.count) || 0;
  } catch (e) { /* ignore */ }
  
  try {
    // Events
    const eventsResult = await db.query(
      `SELECT COUNT(*) as count FROM event_attendees WHERE user_id = $1`,
      [userId]
    );
    progress.event_enthusiast = parseInt(eventsResult.rows[0]?.count) || 0;
  } catch (e) { /* ignore */ }
  
  try {
    // Orders
    const ordersResult = await db.query(
      `SELECT COUNT(*) as count FROM orders WHERE user_id = $1`,
      [userId]
    );
    progress.loyal_customer = parseInt(ordersResult.rows[0]?.count) || 0;
  } catch (e) { /* ignore */ }
  
  return progress;
}

// Get all crew members (public profiles)
router.get('/crew', async (req, res) => {
  try {
    let result;
    
    try {
      result = await db.query(`
        SELECT id, public_id, username, display_name, avatar_base64, created_at,
               COALESCE(is_coach, false) as is_coach, 
               COALESCE(is_staff, false) as is_staff,
               COALESCE(is_club_member, false) as is_club_member,
               role
        FROM users
        WHERE (is_approved = true OR is_approved IS NULL) AND is_admin = false
        ORDER BY is_coach DESC NULLS LAST, username
      `);
    } catch (err) {
      result = await db.query(`
        SELECT id, public_id, username, display_name, created_at
        FROM users
        WHERE is_admin = false OR is_admin IS NULL
        ORDER BY username
      `);
      result.rows = result.rows.map(u => ({
        ...u,
        is_coach: false,
        is_staff: false,
        is_club_member: false,
        role: null,
        avatar_base64: null
      }));
    }
    
    // Add stats
    for (let user of result.rows) {
      try {
        const tricksResult = await db.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status = 'mastered') as mastered,
            COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress
          FROM user_tricks WHERE user_id = $1
        `, [user.id]);
        user.mastered = parseInt(tricksResult.rows[0]?.mastered) || 0;
        user.in_progress = parseInt(tricksResult.rows[0]?.in_progress) || 0;
      } catch (e) {
        user.mastered = 0;
        user.in_progress = 0;
      }
      
      try {
        const articlesResult = await db.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status = 'known') as articles_read,
            COUNT(*) FILTER (WHERE status = 'to_read') as articles_to_read
          FROM user_articles WHERE user_id = $1
        `, [user.id]);
        user.articles_read = parseInt(articlesResult.rows[0]?.articles_read) || 0;
        user.articles_to_read = parseInt(articlesResult.rows[0]?.articles_to_read) || 0;
      } catch (e) {
        user.articles_read = 0;
        user.articles_to_read = 0;
      }
    }
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get crew error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Get user's favorites
router.get('/favorites', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT item_type, item_id FROM favorites WHERE user_id = $1',
      [req.user.id]
    );
    
    const favorites = result.rows;
    
    const response = {
      tricks: favorites.filter(f => f.item_type === 'trick').map(f => f.item_id),
      articles: favorites.filter(f => f.item_type === 'article').map(f => f.item_id),
      users: favorites.filter(f => f.item_type === 'user').map(f => f.item_id)
    };
    
    res.json(response);
  } catch (err) {
    console.error('Get favorites error:', err);
    res.status(500).json({ error: 'Failed to get favorites' });
  }
});

// Toggle favorite
router.post('/favorites', authMiddleware, async (req, res) => {
  try {
    const { item_type, item_id } = req.body;
    
    if (!['trick', 'article', 'user'].includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    
    const existing = await db.query(
      'SELECT id FROM favorites WHERE user_id = $1 AND item_type = $2 AND item_id = $3',
      [req.user.id, item_type, item_id]
    );
    
    if (existing.rows.length > 0) {
      await db.query('DELETE FROM favorites WHERE id = $1', [existing.rows[0].id]);
      res.json({ isFavorite: false });
    } else {
      await db.query(
        'INSERT INTO favorites (user_id, item_type, item_id) VALUES ($1, $2, $3)',
        [req.user.id, item_type, item_id]
      );
      res.json({ isFavorite: true });
    }
  } catch (err) {
    console.error('Toggle favorite error:', err);
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// Update user profile
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const email = req.body.email ? sanitizeEmail(req.body.email) : null;
    const password = req.body.password;
    const userId = req.user.id;

    if (password && password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
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
      const passwordHash = await bcrypt.hash(password, 10);
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
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user avatar
router.put('/me/avatar', authMiddleware, async (req, res) => {
  try {
    const { avatar_base64 } = req.body;
    await db.query(
      'UPDATE users SET avatar_base64 = $1 WHERE id = $2',
      [avatar_base64, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Update avatar error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user achievements by ID
router.get('/:id/achievements', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Calculate progress
    const progress = await calculateUserAchievementsForUser(userId);
    
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
    } catch (e) { /* table may not exist */ }
    
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
          currentTier: manual[id] ? 'special' : null,
          tier: manual[id] ? 'special' : null,
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
    console.error('Get user achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user stats by ID
router.get('/:id/stats', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Trick stats
    const tricksResult = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'mastered') as mastered,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) as total
      FROM user_tricks WHERE user_id = $1
    `, [userId]);
    
    // Article stats
    let articlesResult = { rows: [{ known: 0, to_read: 0 }] };
    try {
      articlesResult = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'known') as known,
          COUNT(*) FILTER (WHERE status = 'to_read') as to_read
        FROM user_articles WHERE user_id = $1
      `, [userId]);
    } catch (e) { /* ignore */ }
    
    // Event stats
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
    } catch (e) { /* ignore */ }
    
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
    console.error('Get user stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's tricks by ID
router.get('/:id/tricks', async (req, res) => {
  try {
    const userId = req.params.id;
    
    const result = await db.query(`
      SELECT ut.id, ut.trick_id, ut.status, ut.updated_at,
             t.name, t.category, t.difficulty
      FROM user_tricks ut
      JOIN tricks t ON ut.trick_id = t.id
      WHERE ut.user_id = $1
      ORDER BY t.category, t.name
    `, [userId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get user tricks error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get reactions for all user's mastered tricks
router.get('/:id/tricks/reactions', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const viewerId = req.user.id;
    
    // Get all mastered tricks for this user
    const tricksResult = await db.query(`
      SELECT trick_id FROM user_tricks WHERE user_id = $1 AND status = 'mastered'
    `, [ownerId]);
    
    const reactions = [];
    
    for (const trick of tricksResult.rows) {
      // Get likes count
      let likesCount = 0;
      let userLiked = false;
      try {
        const likesResult = await db.query(`
          SELECT COUNT(*) as count FROM trick_likes WHERE owner_id = $1 AND trick_id = $2
        `, [ownerId, trick.trick_id]);
        likesCount = parseInt(likesResult.rows[0]?.count) || 0;
        
        const userLikeResult = await db.query(`
          SELECT 1 FROM trick_likes WHERE owner_id = $1 AND trick_id = $2 AND liker_id = $3
        `, [ownerId, trick.trick_id, viewerId]);
        userLiked = userLikeResult.rows.length > 0;
      } catch (e) { /* table may not exist */ }
      
      // Get comments
      let comments = [];
      let commentsCount = 0;
      try {
        const commentsResult = await db.query(`
          SELECT tc.id, tc.content, tc.created_at, u.username as author_username, u.avatar_base64 as author_avatar
          FROM trick_comments tc
          JOIN users u ON tc.author_id = u.id
          WHERE tc.owner_id = $1 AND tc.trick_id = $2
          ORDER BY tc.created_at DESC
          LIMIT 10
        `, [ownerId, trick.trick_id]);
        comments = commentsResult.rows;
        
        const countResult = await db.query(`
          SELECT COUNT(*) as count FROM trick_comments WHERE owner_id = $1 AND trick_id = $2
        `, [ownerId, trick.trick_id]);
        commentsCount = parseInt(countResult.rows[0]?.count) || 0;
      } catch (e) { /* table may not exist */ }
      
      reactions.push({
        trick_id: trick.trick_id,
        likes_count: likesCount,
        comments_count: commentsCount,
        user_liked: userLiked,
        comments: comments.reverse() // oldest first
      });
    }
    
    res.json(reactions);
  } catch (error) {
    console.error('Get trick reactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle like on a trick
router.post('/:id/tricks/:trickId/like', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const trickId = req.params.trickId;
    const likerId = req.user.id;
    
    // Check if already liked
    const existingLike = await db.query(`
      SELECT id FROM trick_likes WHERE owner_id = $1 AND trick_id = $2 AND liker_id = $3
    `, [ownerId, trickId, likerId]);
    
    let userLiked;
    if (existingLike.rows.length > 0) {
      // Unlike
      await db.query(`
        DELETE FROM trick_likes WHERE owner_id = $1 AND trick_id = $2 AND liker_id = $3
      `, [ownerId, trickId, likerId]);
      userLiked = false;
    } else {
      // Like
      await db.query(`
        INSERT INTO trick_likes (owner_id, trick_id, liker_id) VALUES ($1, $2, $3)
      `, [ownerId, trickId, likerId]);
      userLiked = true;
    }
    
    // Get updated count
    const countResult = await db.query(`
      SELECT COUNT(*) as count FROM trick_likes WHERE owner_id = $1 AND trick_id = $2
    `, [ownerId, trickId]);
    
    res.json({
      likes_count: parseInt(countResult.rows[0]?.count) || 0,
      user_liked: userLiked
    });
  } catch (error) {
    console.error('Toggle like error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to a trick
router.post('/:id/tricks/:trickId/comment', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const trickId = req.params.trickId;
    const authorId = req.user.id;
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const result = await db.query(`
      INSERT INTO trick_comments (owner_id, trick_id, author_id, content)
      VALUES ($1, $2, $3, $4)
      RETURNING id, content, created_at
    `, [ownerId, trickId, authorId, content.trim()]);
    
    // Get author info
    const authorResult = await db.query(`
      SELECT username, avatar_base64 FROM users WHERE id = $1
    `, [authorId]);
    
    res.json({
      id: result.rows[0].id,
      content: result.rows[0].content,
      created_at: result.rows[0].created_at,
      author_username: authorResult.rows[0]?.username,
      author_avatar: authorResult.rows[0]?.avatar_base64
    });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
