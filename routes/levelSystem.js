// Level System Routes - /api/level/*
// Self-contained: includes both utility functions and Express routes
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════════════════
// LEVEL SYSTEM CONFIG & FUNCTIONS (inline — no external dependency)
// ═══════════════════════════════════════════════════════════════════

const POINT_VALUES = {
  trick_mastered_regular: 1,
  trick_mastered_goofy:   1,
  article_read:           0.5,
};

const LEVEL_TIERS = [
  { level: 1,  name: 'Wakeboarder',     minPoints: 0,   maxPoints: 10,       icon: '🌊', color: '#818cf8' },
  { level: 2,  name: 'Rider',           minPoints: 10,  maxPoints: 25,       icon: '🏄', color: '#22c55e' },
  { level: 3,  name: 'Progressor',      minPoints: 25,  maxPoints: 45,       icon: '📈', color: '#3b82f6' },
  { level: 4,  name: 'Advanced Rider',  minPoints: 45,  maxPoints: 70,       icon: '⚡', color: '#f59e0b' },
  { level: 5,  name: 'Trick Master',    minPoints: 70,  maxPoints: 100,      icon: '🎯', color: '#ec4899' },
  { level: 6,  name: 'Pro',             minPoints: 100, maxPoints: 130,      icon: '👑', color: '#ef4444' },
  { level: 7,  name: 'Expert',          minPoints: 130, maxPoints: 165,      icon: '⭐', color: '#8b5cf6' },
  { level: 8,  name: 'Master',          minPoints: 165, maxPoints: 200,      icon: '🔥', color: '#fbbf24' },
  { level: 9,  name: 'Legend',           minPoints: 200, maxPoints: 240,      icon: '👹', color: '#06b6d4' },
  { level: 10, name: 'GOAT',            minPoints: 240, maxPoints: 280,      icon: '🐐', color: '#10b981' },
  { level: 11, name: 'Immortal',        minPoints: 280, maxPoints: Infinity,  icon: '💀', color: '#facc15' },
];

const getCurrentLevel = (points) => {
  for (let i = LEVEL_TIERS.length - 1; i >= 0; i--) {
    if (points >= LEVEL_TIERS[i].minPoints) return LEVEL_TIERS[i];
  }
  return LEVEL_TIERS[0];
};

const getNextLevel = (points) => {
  const current = getCurrentLevel(points);
  const nextIndex = LEVEL_TIERS.findIndex(t => t.level === current.level) + 1;
  return nextIndex < LEVEL_TIERS.length ? LEVEL_TIERS[nextIndex] : null;
};

const getProgressToNext = (points) => {
  const current = getCurrentLevel(points);
  const next = getNextLevel(points);
  if (!next) {
    return { current, next: null, currentPoints: points, pointsToNext: 0, progressPercent: 100, isMaxLevel: true };
  }
  const tierSize = next.minPoints - current.minPoints;
  const earned = points - current.minPoints;
  return {
    current, next, currentPoints: points,
    pointsToNext: next.minPoints - points,
    progressPercent: Math.min(100, Math.round((earned / tierSize) * 100)),
    isMaxLevel: false,
  };
};

const getPointBreakdown = (userTricks, userArticleStatus = {}) => {
  let trickPoints = 0, regularCount = 0, goofyCount = 0, articlePoints = 0, articleCount = 0;
  if (userTricks && typeof userTricks === 'object') {
    Object.values(userTricks).forEach((trick) => {
      if (trick?.status === 'mastered' || trick?.regular_status === 'mastered') { trickPoints += POINT_VALUES.trick_mastered_regular; regularCount++; }
      if (trick?.goofy_status === 'mastered') { trickPoints += POINT_VALUES.trick_mastered_goofy; goofyCount++; }
    });
  }
  if (userArticleStatus && typeof userArticleStatus === 'object') {
    Object.values(userArticleStatus).forEach((status) => {
      if (status === 'known') { articlePoints += POINT_VALUES.article_read; articleCount++; }
    });
  }
  return {
    total: trickPoints + articlePoints,
    tricks: { points: trickPoints, regular: regularCount, goofy: goofyCount },
    articles: { points: articlePoints, count: articleCount },
  };
};

// ═══════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════

// GET /api/level/me — current user's level data
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const [tricksRes, articlesRes] = await Promise.all([
      db.query('SELECT trick_id, status, COALESCE(goofy_status, \'todo\') as goofy_status FROM user_tricks WHERE user_id = $1', [userId]),
      db.query('SELECT article_id, status FROM user_articles WHERE user_id = $1', [userId]),
    ]);

    const userTricks = {};
    (tricksRes?.rows || []).forEach(r => {
      userTricks[r.trick_id] = { status: r.status, goofy_status: r.goofy_status };
    });

    const userArticleStatus = {};
    (articlesRes?.rows || []).forEach(r => {
      userArticleStatus[r.article_id] = r.status;
    });

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

// GET /api/level/tiers — all tier definitions (public)
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
