// ============================================================================
// LEVEL SYSTEM LOGGING UTILITIES
// Place in utils/levelLogger.js
// ============================================================================

const log = require('./logger');

/**
 * Log level calculation
 */
const logLevelCalculation = (userId, oldLevel, newLevel, oldPoints, newPoints, triggerType = 'manual') => {
  const levelUp = newLevel > oldLevel;
  const pointsGain = newPoints - oldPoints;

  if (levelUp) {
    log.info('🎉 LEVEL UP!', {
      userId,
      from: oldLevel,
      to: newLevel,
      pointsOld: oldPoints,
      pointsNew: newPoints,
      pointsGain,
      triggerType
    });
  } else if (pointsGain > 0) {
    log.info('📈 Level points increased', {
      userId,
      level: newLevel,
      pointsOld: oldPoints,
      pointsNew: newPoints,
      pointsGain,
      triggerType
    });
  } else if (pointsGain < 0) {
    log.warn('⚠️ Level points decreased', {
      userId,
      level: newLevel,
      pointsOld: oldPoints,
      pointsNew: newPoints,
      pointsGain,
      triggerType
    });
  }
};

/**
 * Log level fetch
 */
const logLevelFetch = (userId, levelData, source = 'api') => {
  log.debug('📊 Level data fetched', {
    userId,
    level: levelData.level,
    points: levelData.points,
    source,
    cached: source === 'cache',
    calculationCount: levelData.calculationCount
  });
};

/**
 * Log level sync
 */
const logLevelSync = (userId, backendLevel, frontendLevel, match = true) => {
  if (match) {
    log.debug('✅ Level sync - data matches', {
      userId,
      level: backendLevel,
      frontendLevel
    });
  } else {
    log.warn('⚠️ Level sync - MISMATCH!', {
      userId,
      backend: backendLevel,
      frontend: frontendLevel,
      action: 'frontend will update'
    });
  }
};

/**
 * Log trigger execution
 */
const logTriggerExecution = (userId, trickId, stance, oldStatus, newStatus, resultLevel, resultPoints) => {
  log.info('🔄 Level trigger executed', {
    userId,
    trickId,
    stance,
    statusChange: `${oldStatus} → ${newStatus}`,
    resultLevel,
    resultPoints,
    timestamp: new Date().toISOString()
  });
};

/**
 * Log calculation error
 */
const logCalculationError = (userId, error, context = {}) => {
  log.error('❌ Level calculation error', {
    userId,
    error: error.message,
    stack: error.stack,
    context,
    timestamp: new Date().toISOString()
  });
};

/**
 * Log cache invalidation
 */
const logCacheInvalidation = (userId, cacheKeys) => {
  log.debug('🗑️ Level cache invalidated', {
    userId,
    keys: cacheKeys,
    count: cacheKeys.length,
    timestamp: new Date().toISOString()
  });
};

/**
 * Log leaderboard calculation
 */
const logLeaderboardCalculation = (userCount, topUser) => {
  log.info('📊 Leaderboard calculated', {
    totalUsers: userCount,
    topUser: {
      userId: topUser.id,
      level: topUser.current_level,
      points: topUser.level_points
    },
    timestamp: new Date().toISOString()
  });
};

/**
 * Validate level data consistency
 */
const validateLevelConsistency = (userId, levelData, trickStats) => {
  const maxPossiblePoints = trickStats.total * 2; // Each trick max 2 points
  const isValid = 
    levelData.points >= 0 &&
    levelData.points <= maxPossiblePoints &&
    levelData.level >= 1 &&
    levelData.level <= 10;

  if (!isValid) {
    log.error('❌ Level data inconsistency detected!', {
      userId,
      levelData,
      trickStats,
      maxPossiblePoints,
      issues: [
        levelData.points > maxPossiblePoints ? `Points exceed max (${maxPossiblePoints})` : null,
        levelData.level < 1 ? 'Level below minimum (1)' : null,
        levelData.level > 10 ? 'Level above maximum (10)' : null
      ].filter(Boolean)
    });
  }

  return isValid;
};

/**
 * Generate level change report
 */
const generateLevelChangeReport = (userId, oldLevel, newLevel, oldPoints, newPoints, trickDetails) => {
  return {
    userId,
    timestamp: new Date().toISOString(),
    change: {
      level: { old: oldLevel, new: newLevel, up: newLevel > oldLevel },
      points: { old: oldPoints, new: newPoints, gain: newPoints - oldPoints }
    },
    trickDetails,
    summary: `User #${userId}: Level ${oldLevel}→${newLevel} | Points ${oldPoints}→${newPoints} (+${newPoints - oldPoints})`
  };
};

module.exports = {
  logLevelCalculation,
  logLevelFetch,
  logLevelSync,
  logTriggerExecution,
  logCalculationError,
  logCacheInvalidation,
  logLeaderboardCalculation,
  validateLevelConsistency,
  generateLevelChangeReport
};
