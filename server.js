// Flatwater by Lunar - Server API
// VERSION: v89-performance
// Perf: #1 pool 50, #2 compression, #3 in-memory cache, #4 bootstrap endpoint

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const db = require('./database');
const config = require('./config');
const routes = require('./routes');
const { corsPreflightHandler, corsMiddleware } = require('./middleware/cors');
const { STATUS } = require('./utils/constants');
const log = require('./utils/logger');
const tokenBlacklist = require('./utils/tokenBlacklist');

const app = express();

// Handle preflight OPTIONS requests FIRST
app.options('*', corsPreflightHandler);

// Apply CORS
app.use(corsMiddleware);

// Helmet — comprehensive security headers (replaces manual securityHeaders)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false,    // breaks loading cross-origin images/fonts
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow cross-origin requests from frontend
  hsts: config.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT
    ? { maxAge: 31536000, includeSubDomains: true }
    : false,
}));

// Perf #2: Gzip compression — reduces JSON payload ~60-70%
app.use(compression({ level: 6, threshold: 1024 }));

// Fix #3: Request timeout — kills zombie requests after 30s
app.use((req, res, next) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      log.warn('Request timeout', { method: req.method, url: req.originalUrl });
      res.status(504).json({ error: 'Request timeout' });
    }
  }, 30000);
  
  res.on('finish', () => clearTimeout(timeout));
  res.on('close', () => clearTimeout(timeout));
  next();
});

// Stripe webhook needs raw body BEFORE json parsing
if (config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET) {
  const { handleWebhook } = require('./routes/stripe');
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleWebhook);
  log.info('Stripe webhook endpoint mounted');
}

// JSON body parser — 500KB default (hardening: was 2MB)
app.use(express.json({ limit: '500kb' }));

// Mount all API routes under /api
// Prevent browsers from caching API responses (stale personal data risk)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use('/api', routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  log.error('Unhandled server error', { error: err, url: req.originalUrl });
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// Fix #15: Stale order cleanup — removes abandoned pending_payment orders
// ============================================================================
async function cleanupStaleOrders() {
  try {
    const result = await db.query(
      `DELETE FROM orders WHERE status = $1 AND created_at < NOW() - INTERVAL '24 hours' RETURNING id`,
      [STATUS.PENDING_PAYMENT]
    );
    if (result.rows.length > 0) {
      log.info('Cleaned up stale orders', { count: result.rows.length });
    }
  } catch (e) {
    log.error('Stale order cleanup failed', { error: e });
  }
}

// Start server
let server;

const startServer = async () => {
  try {
    log.info('='.repeat(50));
    log.info('Flatwater by Lunar - Server Starting');
    log.info('VERSION: v89-performance');
    log.info('='.repeat(50));
    log.info('Environment check', {
      JWT_SECRET: process.env.JWT_SECRET ? '✅' : '⚠️ NOT SET',
      POSTMARK_API_KEY: process.env.POSTMARK_API_KEY ? '✅' : '⚠️ NOT SET',
      DATABASE_URL: process.env.DATABASE_URL ? '✅' : '⚠️ NOT SET',
      STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY ? '✅' : '⚠️ NOT SET',
      STRIPE_WEBHOOK_SECRET: config.STRIPE_WEBHOOK_SECRET ? '✅' : '⚠️ NOT SET',
      MIGRATION_KEY: config.MIGRATION_KEY ? '✅' : '⚠️ NOT SET',
      GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID ? '✅' : '⚠️ NOT SET',
    });
    
    // Initialize database
    await db.initDatabase();
    
    // Run essential column migrations
    log.info('Running column migrations...');
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255)`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT false`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_coach BOOLEAN DEFAULT false`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN DEFAULT false`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_club_member BOOLEAN DEFAULT false`);
      // Google OAuth columns
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`);
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'email'`);
      try { await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL`); } catch(e) { /* exists */ }
      try {
        await db.query(`ALTER TABLE event_attendees RENAME COLUMN created_at TO registered_at`);
        log.info('Renamed event_attendees.created_at → registered_at');
      } catch (e) { /* already renamed */ }
      try {
        await db.query(`ALTER TABLE rfid_bands ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
        await db.query(`ALTER TABLE rfid_bands ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP DEFAULT NOW()`);
      } catch (e) { /* already exists */ }
      try {
        await db.query(`ALTER TABLE trick_comments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false`);
        await db.query(`ALTER TABLE trick_comments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
        await db.query(`ALTER TABLE trick_comments ADD COLUMN IF NOT EXISTS deleted_by INTEGER`);
        await db.query(`ALTER TABLE achievement_comments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false`);
        await db.query(`ALTER TABLE achievement_comments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
        await db.query(`ALTER TABLE achievement_comments ADD COLUMN IF NOT EXISTS deleted_by INTEGER`);
      } catch (e) { /* already exists */ }
      log.info('Column migrations complete');
    } catch (migrationErr) {
      log.warn('Some migrations failed (may already exist)', { error: migrationErr.message });
    }
    
    // Load token blacklist into memory (session revocation)
    await tokenBlacklist.loadBlacklist();
    await tokenBlacklist.loadForceLogouts();
    
    // Fix #15: Run stale order cleanup on startup + every hour
    await cleanupStaleOrders();
    const cleanupInterval = setInterval(cleanupStaleOrders, 60 * 60 * 1000);
    
    server = app.listen(config.PORT, () => {
      log.info(`Flatwater API running on port ${config.PORT}`);
    });
    
    // Fix #11: Graceful shutdown
    const shutdown = async (signal) => {
      log.info(`${signal} received — shutting down gracefully`);
      
      clearInterval(cleanupInterval);
      
      server.close(async () => {
        log.info('HTTP server closed');
        try {
          await db.pool.end();
          log.info('Database pool closed');
        } catch (e) {
          log.error('Error closing database pool', { error: e });
        }
        process.exit(0);
      });
      
      // Force exit after 10s if graceful shutdown stalls
      setTimeout(() => {
        log.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
  } catch (error) {
    log.error('Failed to start server', { error });
    process.exit(1);
  }
};

startServer();
