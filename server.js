// Flatwater by Lunar - Server API
// VERSION: v81-modular-2025-01-26
// Refactored to modular structure

const express = require('express');
const db = require('./database');
const config = require('./config');
const routes = require('./routes');
const { corsPreflightHandler, corsMiddleware, securityHeaders } = require('./middleware/cors');

const app = express();

// Handle preflight OPTIONS requests FIRST
app.options('*', corsPreflightHandler);

// Apply middleware
app.use(corsMiddleware);
app.use(securityHeaders);
app.use(express.json({ limit: '10mb' }));

// Mount all API routes under /api
app.use('/api', routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const startServer = async () => {
  try {
    console.log('='.repeat(50));
    console.log('Flatwater by Lunar - Server Starting');
    console.log('VERSION: v81-modular');
    console.log('='.repeat(50));
    console.log('Environment check:');
    console.log('  - JWT_SECRET:', process.env.JWT_SECRET ? '✅ Set' : '⚠️ NOT SET (using fallback)');
    console.log('  - POSTMARK_API_KEY:', process.env.POSTMARK_API_KEY ? '✅ Set' : '⚠️ NOT SET');
    console.log('  - DATABASE_URL:', process.env.DATABASE_URL ? '✅ Set' : '⚠️ NOT SET');
    console.log('  - STRIPE_SECRET_KEY:', config.STRIPE_SECRET_KEY?.startsWith('sk_') ? '✅ Set' : '⚠️ Using test key');
    console.log('='.repeat(50));
    
    // Initialize database
    await db.initDatabase();
    
    // Run essential column migrations
    console.log('🔄 Running column migrations...');
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
      console.log('✅ Column migrations complete');
    } catch (migrationErr) {
      console.warn('⚠️ Some migrations failed (may already exist):', migrationErr.message);
    }
    
    app.listen(config.PORT, () => {
      console.log(`🚀 Flatwater API running on port ${config.PORT}`);
      console.log('='.repeat(50));
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
