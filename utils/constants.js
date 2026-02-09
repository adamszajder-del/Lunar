// Status constants — prevents silent bugs from typos like 'masterd' instead of 'mastered'
// Usage: const { STATUS, ITEM_TYPE, NOTIFICATION } = require('../utils/constants');

const STATUS = Object.freeze({
  // Trick statuses
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  MASTERED: 'mastered',

  // Article statuses
  FRESH: 'fresh',
  TO_READ: 'to_read',
  KNOWN: 'known',

  // Order statuses
  PENDING_PAYMENT: 'pending_payment',
  COMPLETED: 'completed',
  SHIPPED: 'shipped',
  PENDING_SHIPMENT: 'pending_shipment',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',

  // Achievement tiers
  BRONZE: 'bronze',
  SILVER: 'silver',
  GOLD: 'gold',
  PLATINUM: 'platinum',
  SPECIAL: 'special',
});

const ITEM_TYPE = Object.freeze({
  TRICK: 'trick',
  ARTICLE: 'article',
  USER: 'user',
});

const NOTIFICATION_TYPE = Object.freeze({
  TRICK_LIKE: 'trick_like',
  TRICK_COMMENT: 'trick_comment',
  ACHIEVEMENT_LIKE: 'achievement_like',
  ACHIEVEMENT_COMMENT: 'achievement_comment',
  COMMENT_LIKE: 'comment_like',
  FRIEND_TRICK: 'friend_trick',
  FRIEND_ACHIEVEMENT: 'friend_achievement',
  PURCHASE: 'purchase',
});

const COMPLETED_ORDER_STATUSES = [STATUS.COMPLETED, STATUS.SHIPPED, STATUS.PENDING_SHIPMENT];

module.exports = { STATUS, ITEM_TYPE, NOTIFICATION_TYPE, COMPLETED_ORDER_STATUSES };
