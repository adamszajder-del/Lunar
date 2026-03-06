/**
 * 🏆 LUNAR LEVEL SYSTEM v2 (CommonJS)
 * Single source of truth for levels, points, and progression.
 * 
 * Points: Regular tricks (+1), Goofy tricks (+1), Articles read (+0.5)
 * Level: Based on cumulative points, 11 tiers
 * 
 * Used by: routes/levelSystem.js (API), routes/tricks.js, routes/articles.js
 */

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

const calculatePoints = (userTricks, userArticleStatus = {}) => {
  let points = 0;
  if (userTricks && typeof userTricks === 'object') {
    Object.values(userTricks).forEach((trick) => {
      if (trick?.status === 'mastered' || trick?.regular_status === 'mastered') {
        points += POINT_VALUES.trick_mastered_regular;
      }
      if (trick?.goofy_status === 'mastered') {
        points += POINT_VALUES.trick_mastered_goofy;
      }
    });
  }
  if (userArticleStatus && typeof userArticleStatus === 'object') {
    Object.values(userArticleStatus).forEach((status) => {
      if (status === 'known') {
        points += POINT_VALUES.article_read;
      }
    });
  }
  return points;
};

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

const countInProgressTricks = (userTricks) => {
  if (!userTricks) return 0;
  return Object.values(userTricks).filter(t => t?.status === 'in_progress' || t?.regular_status === 'in_progress' || t?.goofy_status === 'in_progress').length;
};

const projectLevel = (currentPoints, additionalTricks, bothSides = true) => {
  const pointsPerTrick = bothSides ? 2 : 1;
  const projectedPoints = currentPoints + additionalTricks * pointsPerTrick;
  const projectedLevel = getCurrentLevel(projectedPoints);
  const currentLevel = getCurrentLevel(currentPoints);
  return { currentLevel, currentPoints, additionalTricks, pointsGain: additionalTricks * pointsPerTrick, projectedPoints, projectedLevel, levelUp: projectedLevel.level > currentLevel.level, newLevelName: projectedLevel.name };
};

const getLevelData = (userTricks, userArticleStatus = {}) => {
  const points = calculatePoints(userTricks, userArticleStatus);
  const progress = getProgressToNext(points);
  const breakdown = getPointBreakdown(userTricks, userArticleStatus);
  const inProgressCount = countInProgressTricks(userTricks);
  const projection = inProgressCount > 0 ? projectLevel(points, inProgressCount, true) : null;
  return {
    points, breakdown, progress, inProgressCount, projection,
    currentLevel: progress.current, nextLevel: progress.next,
    levelName: progress.current.name, levelIcon: progress.current.icon, levelColor: progress.current.color,
    progressPercent: progress.progressPercent, pointsToNext: progress.pointsToNext, isMaxLevel: progress.isMaxLevel,
  };
};

module.exports = {
  POINT_VALUES, LEVEL_TIERS,
  calculatePoints, getCurrentLevel, getNextLevel, getProgressToNext,
  getPointBreakdown, countInProgressTricks, projectLevel, getLevelData,
};
