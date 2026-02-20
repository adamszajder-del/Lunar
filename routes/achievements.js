// Achievements Routes - /api/achievements/*
// Fix #5: Single source of truth for achievement calculation (exported for users.js)
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { STATUS, COMPLETED_ORDER_STATUSES } = require('../utils/constants');
const log = require('../utils/logger');

// Achievement definitions
const ACHIEVEMENTS = {
  trick_master: {
    id: 'trick_master', name: 'Trick Master', icon: '🏆',
    description: 'Master wakeboard tricks across all categories. Earn higher tiers by mastering more tricks — from your first trick all the way to 50!',
    type: 'automatic',
    tiers: { bronze: 1, silver: 10, gold: 25, platinum: 50 }, category: 'tricks'
  },
  knowledge_seeker: {
    id: 'knowledge_seeker', name: 'Knowledge Seeker', icon: '📚',
    description: 'Read articles in the Learn section to expand your wakeboarding knowledge. Mark articles as read to track your progress.',
    type: 'automatic',
    tiers: { bronze: 1, silver: 5, gold: 15, platinum: 30 }, category: 'articles'
  },
  event_enthusiast: {
    id: 'event_enthusiast', name: 'Event Enthusiast', icon: '📅',
    description: 'Join sessions and events at Lunar Cable Park. The more you ride with us, the higher your tier!',
    type: 'automatic',
    tiers: { bronze: 1, silver: 5, gold: 15, platinum: 30 }, category: 'events'
  },
  loyal_friend: {
    id: 'loyal_friend', name: 'Loyal Friend', icon: '💜',
    description: 'Support Lunar by making purchases in the shop. Every order counts towards your next tier.',
    type: 'automatic',
    tiers: { bronze: 1, silver: 5, gold: 15, platinum: 30 }, category: 'orders'
  },
  veteran: {
    id: 'veteran', name: 'Veteran', icon: '⏳',
    description: 'Stay with us! This achievement tracks how many days you have been a Lunar member. Time flies when you are having fun on the water.',
    type: 'automatic',
    tiers: { bronze: 1, silver: 30, gold: 90, platinum: 365 }, category: 'account'
  },
  surface_pro: {
    id: 'surface_pro', name: 'Surface Pro', icon: '🌊',
    description: 'Master surface tricks like 180s, 360s, and other on-water rotations. Show your edge control skills!',
    type: 'automatic',
    tiers: { bronze: 1, silver: 3, gold: 6, platinum: 10 }, category: 'tricks_surface'
  },
  air_acrobat: {
    id: 'air_acrobat', name: 'Air Acrobat', icon: '✈️',
    description: 'Take flight! Master air tricks including jumps, flips, and inversions off the wake.',
    type: 'automatic',
    tiers: { bronze: 1, silver: 3, gold: 6, platinum: 10 }, category: 'tricks_air'
  },
  rail_rider: {
    id: 'rail_rider', name: 'Rail Rider', icon: '🛹',
    description: 'Conquer the rails! Master grinds, slides, and rail combos at the cable park.',
    type: 'automatic',
    tiers: { bronze: 1, silver: 2, gold: 4, platinum: 6 }, category: 'tricks_rail'
  },
  kicker_king: {
    id: 'kicker_king', name: 'Kicker King', icon: '🚀',
    description: 'Launch off kickers and master kicker tricks. Bigger air, bigger rewards!',
    type: 'automatic',
    tiers: { bronze: 1, silver: 2, gold: 4, platinum: 6 }, category: 'tricks_kicker'
  },
  profile_pro: {
    id: 'profile_pro', name: 'Profile Pro', icon: '👤',
    description: 'Complete your profile by uploading an avatar photo. Show the crew who you are!',
    type: 'automatic',
    tiers: { platinum: 1 }, category: 'profile'
  },
  dedicated_rider: {
    id: 'dedicated_rider', name: 'Dedicated Rider', icon: '🔥',
    description: 'Keep your login streak alive! Visit the app daily to build your streak and prove your dedication.',
    type: 'automatic',
    tiers: { bronze: 1, silver: 7, gold: 14, platinum: 30 }, category: 'streak'
  },
  // Manual achievements
  wings4life: {
    id: 'wings4life', name: 'Wings 4 Life', icon: '🦅',
    description: 'Awarded for participating in a Wings 4 Life charity event at Lunar Cable Park.',
    type: 'manual', tiers: { special: 1 }, category: 'special'
  },
  vip_guest: {
    id: 'vip_guest', name: 'VIP Guest', icon: '⭐',
    description: 'Awarded to special guests, influencers, and VIP visitors of Lunar Cable Park.',
    type: 'manual', tiers: { special: 1 }, category: 'special'
  },
  camp_graduate: {
    id: 'camp_graduate', name: 'Camp Graduate', icon: '🎓',
    description: 'Awarded for successfully completing an official Lunar Wakeboard Camp.',
    type: 'manual', tiers: { special: 1 }, category: 'special'
  },
  competition_winner: {
    id: 'competition_winner', name: 'Competition Winner', icon: '🏅',
    description: 'Awarded for winning or placing in an official wakeboard competition at Lunar.',
    type: 'manual', tiers: { special: 1 }, category: 'special'
  }
};

// ============================================================================
// Fix #5: Consolidated achievement calculation — single function used everywhere
// ============================================================================
async function calculateUserAchievements(userId) {
  const results = {};
  
  try {
    const userResult = await db.query('SELECT created_at, avatar_base64 FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return results;
    const user = userResult.rows[0];
    
    // Tricks mastered by category — single query for all trick achievements
    const tricksResult = await db.query(`
      SELECT t.category, 
        (COUNT(*) FILTER (WHERE ut.status = $2) + COUNT(*) FILTER (WHERE COALESCE(ut.goofy_status, 'todo') = $2)) as count
      FROM user_tricks ut
      JOIN tricks t ON ut.trick_id = t.id
      WHERE ut.user_id = $1
      GROUP BY t.category
    `, [userId, STATUS.MASTERED]);
    
    let totalMastered = 0;
    const tricksByCategory = {};
    tricksResult.rows.forEach(row => {
      tricksByCategory[row.category] = parseInt(row.count);
      totalMastered += parseInt(row.count);
    });
    
    results.trick_master = totalMastered;
    results.surface_pro = tricksByCategory['surface'] || 0;
    results.air_acrobat = tricksByCategory['air'] || 0;
    results.rail_rider = tricksByCategory['rail'] || 0;
    results.kicker_king = tricksByCategory['kicker'] || 0;
    
    // Articles read
    try {
      const articlesResult = await db.query(
        `SELECT COUNT(*) as count FROM user_articles WHERE user_id = $1 AND status = $2`,
        [userId, STATUS.KNOWN]
      );
      results.knowledge_seeker = parseInt(articlesResult.rows[0]?.count || 0);
    } catch (e) { 
      log.warn('Articles count failed', { userId, error: e.message });
      results.knowledge_seeker = 0; 
    }
    
    // Events joined
    const eventsResult = await db.query(
      'SELECT COUNT(*) as count FROM event_attendees WHERE user_id = $1',
      [userId]
    );
    results.event_enthusiast = parseInt(eventsResult.rows[0]?.count || 0);
    
    // Orders completed
    try {
      const ordersResult = await db.query(
        `SELECT COUNT(*) as count FROM orders WHERE user_id = $1 AND status = ANY($2) AND fake = false`,
        [userId, COMPLETED_ORDER_STATUSES]
      );
      results.loyal_friend = parseInt(ordersResult.rows[0]?.count || 0);
    } catch (e) { 
      log.warn('Orders count failed', { userId, error: e.message });
      results.loyal_friend = 0; 
    }
    
    // Days since registration
    const daysSinceReg = Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));
    results.veteran = daysSinceReg;
    
    // Profile completed
    results.profile_pro = user.avatar_base64 ? 1 : 0;
    
    // Login streak — consistent logic (counts consecutive days backward from today)
    try {
      const streakResult = await db.query(`
        SELECT DATE(login_time) as login_date
        FROM user_logins WHERE user_id = $1 AND success = true
        GROUP BY DATE(login_time) ORDER BY login_date DESC
        LIMIT 365
      `, [userId]);
      
      let streak = 0;
      if (streakResult.rows.length > 0) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let expectedDate = today;
        
        for (const row of streakResult.rows) {
          const loginDate = new Date(row.login_date);
          loginDate.setHours(0, 0, 0, 0);
          const diffDays = Math.round((expectedDate - loginDate) / (1000 * 60 * 60 * 24));
          
          if (diffDays === 0 || diffDays === 1) {
            streak++;
            expectedDate = new Date(loginDate);
            expectedDate.setDate(expectedDate.getDate() - 1);
          } else break;
        }
      }
      results.dedicated_rider = streak;
    } catch (e) { 
      log.warn('Streak calc failed', { userId, error: e.message });
      results.dedicated_rider = 0; 
    }
    
  } catch (err) {
    log.error('Error calculating achievements', { userId, error: err });
  }
  
  return results;
}

// Determine tier from value
function determineTier(value, tiers) {
  if (tiers.special !== undefined) return value >= tiers.special ? 'special' : null;
  if (tiers.platinum !== undefined && value >= tiers.platinum) return 'platinum';
  if (tiers.gold !== undefined && value >= tiers.gold) return 'gold';
  if (tiers.silver !== undefined && value >= tiers.silver) return 'silver';
  if (tiers.bronze !== undefined && value >= tiers.bronze) return 'bronze';
  return null;
}

function tierRank(tier) {
  const ranks = { bronze: 1, silver: 2, gold: 3, platinum: 4, special: 5 };
  return ranks[tier] || 0;
}

// ============================================================================
// ROUTES
// ============================================================================

// Get all achievement definitions
router.get('/', (req, res) => {
  res.json(ACHIEVEMENTS);
});

// Get user's achievements
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const progress = await calculateUserAchievements(userId);
    
    const storedResult = await db.query(
      'SELECT achievement_id, tier, achieved_at FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    
    const stored = {};
    storedResult.rows.forEach(row => {
      stored[row.achievement_id] = { tier: row.tier, achieved_at: row.achieved_at };
    });
    
    let manualResult = { rows: [] };
    try {
      manualResult = await db.query(
        'SELECT achievement_id, awarded_at FROM user_manual_achievements WHERE user_id = $1',
        [userId]
      );
    } catch (e) { log.warn('Manual achievements table missing'); }
    
    const manual = {};
    manualResult.rows.forEach(row => {
      manual[row.achievement_id] = { achieved_at: row.awarded_at };
    });
    
    const achievements = {};
    for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
      if (def.type === 'manual') {
        achievements[id] = {
          ...def,
          achieved: !!manual[id],
          currentTier: manual[id] ? 'special' : null,
          tier: manual[id] ? 'special' : null,
          progress: manual[id] ? 1 : 0,
          achieved_at: manual[id]?.achieved_at || null
        };
      } else {
        const currentValue = progress[id] || 0;
        const currentTier = determineTier(currentValue, def.tiers);
        
        // Update stored if new tier
        if (currentTier && (!stored[id] || tierRank(currentTier) > tierRank(stored[id].tier))) {
          try {
            await db.query(`
              INSERT INTO user_achievements (user_id, achievement_id, tier)
              VALUES ($1, $2, $3)
              ON CONFLICT (user_id, achievement_id)
              DO UPDATE SET tier = $3, achieved_at = NOW()
            `, [userId, id, currentTier]);
            stored[id] = { tier: currentTier, achieved_at: new Date() };
          } catch (e) { log.warn('Achievement upsert failed', { id, error: e.message }); }
        }
        
        achievements[id] = {
          ...def,
          achieved: !!currentTier,
          currentTier,
          tier: currentTier,
          progress: currentValue,
          current: currentValue,
          achieved_at: stored[id]?.achieved_at || null
        };
      }
    }
    
    const achievementsList = Object.values(achievements);
    const earned = achievementsList.filter(a => a.achieved).length;
    const total = achievementsList.length;
    const special = achievementsList.filter(a => a.type === 'manual' && a.achieved).length;
    const streak = progress.dedicated_rider || 0;
    
    res.json({ 
      achievements, 
      stats: { earned, total, special, streak } 
    });
  } catch (error) {
    log.error('Get my achievements error', { error });
    res.status(500).json({ error: 'Server error' });
  }
});

// Check achievements (trigger recalculation)
router.post('/check', authMiddleware, async (req, res) => {
  try {
    await calculateUserAchievements(req.user.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
// Fix #5: Export shared functions for users.js
module.exports.ACHIEVEMENTS = ACHIEVEMENTS;
module.exports.calculateUserAchievements = calculateUserAchievements;
module.exports.determineTier = determineTier;
