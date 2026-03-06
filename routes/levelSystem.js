// Level System Routes - /api/level/*
// Provides level data endpoints, computed from user tricks + articles
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { getCurrentLevel, getProgressToNext, getPointBreakdown, LEVEL_TIERS } = require('../utils/levelSystem');

// GET /api/level/me — current user's level data
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch tricks + articles in parallel
    const [tricksRes, articlesRes] = await Promise.all([
      db.query('SELECT trick_id, status, COALESCE(goofy_status, \'todo\') as goofy_status FROM user_tricks WHERE user_id = $1', [userId]),
      db.query('SELECT article_id, status FROM user_articles WHERE user_id = $1', [userId]),
    ]);

    // Build objects matching frontend shape
    const userTricks = {};
    (tricksRes?.rows || []).forEach(r => {
      userTricks[r.trick_id] = { status: r.status, goofy_status: r.goofy_status };
    });

    const userArticleStatus = {};
    (articlesRes?.rows || []).forEach(r => {
      userArticleStatus[r.article_id] = r.status;
    });

    // Calculate
    const breakdown = getPointBreakdown(userTricks, userArticleStatus);
    const points = breakdown.total;
    const current = getCurrentLevel(points);
    const { next, progressPercent, pointsToNext, isMaxLevel } = getProgressToNext(points);

    res.json({
      level: current.level,
      name: current.name,
      icon: current.icon,
      color: current.color,
      points,
      breakdown: {
        tricks: breakdown.tricks,
        articles: breakdown.articles,
      },
      progress_percent: progressPercent,
      points_to_next: pointsToNext,
      next_level: next ? { level: next.level, name: next.name, min_points: next.minPoints } : null,
      is_max_level: isMaxLevel,
    });
  } catch (err) {
    console.error('Level fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch level data' });
  }
});

// GET /api/level/tiers — all tier definitions (public, for display)
router.get('/tiers', (req, res) => {
  res.json(LEVEL_TIERS.map(t => ({
    level: t.level,
    name: t.name,
    icon: t.icon,
    color: t.color,
    min_points: t.minPoints,
    max_points: t.maxPoints === Infinity ? null : t.maxPoints,
  })));
});

module.exports = router;
