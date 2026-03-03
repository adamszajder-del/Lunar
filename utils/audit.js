// Audit Log Utility
// Lightweight action tracking: who did what, when
// Table auto-creates on first use
// IMMUTABLE: No update/delete functions exposed — append-only by design

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
        action VARCHAR(30) NOT NULL,
        details JSONB,
        user_id INTEGER,
        user_name VARCHAR(100),
        ip_address VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)`);
    // Add details column if missing (upgrade from older schema)
    try { await db.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS details JSONB`); } catch(e) {}
    try { await db.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address VARCHAR(100)`); } catch(e) {}
    tableReady = true;
  } catch (e) {
    // Table likely exists already
    tableReady = true;
  }
};

/**
 * Log an admin action (APPEND-ONLY — no update/delete exposed)
 * @param {string} entityType - 'trick', 'article', 'event', 'news', 'user', 'product', 'rfid', 'achievement', 'comment'
 * @param {number|string} entityId - ID of the entity
 * @param {string} action - 'created', 'updated', 'deleted', 'blocked', 'unblocked', 'approved', 'rejected',
 *                          'roles_changed', 'granted', 'revoked', 'soft_deleted', 'restored', 'password_reset'
 * @param {object} user - req.user object (needs .id and .display_name or .username)
 * @param {string} [entityName] - optional human-readable name for the log
 * @param {object} [details] - optional JSON details (changed fields, before/after, etc.)
 * @param {string} [ipAddress] - optional IP address from request
 */
const logAction = async (entityType, entityId, action, user, entityName = null, details = null, ipAddress = null) => {
  try {
    await ensureTable();
    const userName = user?.display_name || user?.username || 'System';
    await db.query(
      `INSERT INTO audit_log (entity_type, entity_id, entity_name, action, details, user_id, user_name, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entityType, entityId || 0, entityName, action, details ? JSON.stringify(details) : null, user?.id || null, userName, ipAddress]
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
    `SELECT action, user_name, details, ip_address, created_at
     FROM audit_log
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC
     LIMIT 50`,
    [entityType, entityId]
  );
  return result.rows;
};

/**
 * Get full audit log (admin panel — paginated)
 * @param {object} opts - { limit, offset, entityType, action, userId }
 */
const getFullLog = async (opts = {}) => {
  await ensureTable();
  const { limit = 50, offset = 0, entityType, action, userId } = opts;
  const conditions = [];
  const params = [];
  let idx = 1;

  if (entityType) { conditions.push(`entity_type = $${idx++}`); params.push(entityType); }
  if (action) { conditions.push(`action = $${idx++}`); params.push(action); }
  if (userId) { conditions.push(`user_id = $${idx++}`); params.push(userId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const result = await db.query(
    `SELECT id, entity_type, entity_id, entity_name, action, details, user_id, user_name, ip_address, created_at
     FROM audit_log ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM audit_log ${where}`,
    params.slice(0, -2) // exclude limit/offset
  );

  return { rows: result.rows, total: parseInt(countResult.rows[0].total) };
};

module.exports = { logAction, getHistory, getFullLog };
