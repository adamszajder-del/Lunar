// Audit Log Utility
// Lightweight action tracking: who did what, when
// Table auto-creates on first use

const db = require('../database');

let tableReady = false;

const ensureTable = async () => {
  if (tableReady) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        entity_type VARCHAR(20) NOT NULL,
        entity_id INTEGER NOT NULL,
        entity_name VARCHAR(255),
        action VARCHAR(20) NOT NULL,
        user_id INTEGER,
        user_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`);
    tableReady = true;
  } catch (e) {
    // Table likely exists already
    tableReady = true;
  }
};

/**
 * Log an admin action
 * @param {string} entityType - 'trick', 'article', 'event', 'news', 'user'
 * @param {number} entityId - ID of the entity
 * @param {string} action - 'created', 'updated', 'deleted', 'blocked', 'unblocked', 'approved', 'rejected', 'roles_changed'
 * @param {object} user - req.user object (needs .id and .display_name or .username)
 * @param {string} [entityName] - optional human-readable name for the log
 */
const logAction = async (entityType, entityId, action, user, entityName = null) => {
  try {
    await ensureTable();
    const userName = user?.display_name || user?.username || 'System';
    await db.query(
      `INSERT INTO audit_log (entity_type, entity_id, entity_name, action, user_id, user_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entityType, entityId, entityName, action, user?.id || null, userName]
    );
  } catch (e) {
    // Never let audit logging break the main operation
    console.error('Audit log error:', e.message);
  }
};

/**
 * Get history for an entity
 * @param {string} entityType
 * @param {number} entityId
 * @returns {Array} history entries
 */
const getHistory = async (entityType, entityId) => {
  await ensureTable();
  const result = await db.query(
    `SELECT action, user_name, created_at
     FROM audit_log
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC
     LIMIT 50`,
    [entityType, entityId]
  );
  return result.rows;
};

module.exports = { logAction, getHistory };
