// Migrations Routes - /api/run-*-migration
const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcryptjs');
let cache;
try { cache = require('../utils/cache').cache; } catch(e) { cache = { invalidatePrefix: () => {} }; }
const { generatePublicId } = require('../utils/publicId');
const config = require('../config');

// Migration key MUST come from environment variable - no hardcoded fallback
const MIGRATION_KEY = config.MIGRATION_KEY;
if (!MIGRATION_KEY) {
  console.warn('⚠️  MIGRATION_KEY not set — all migration endpoints are locked');
}

// Shared auth check for all migration endpoints
const checkMigrationKey = (req, res) => {
  if (!MIGRATION_KEY) {
    res.status(403).json({ error: 'Migrations locked — MIGRATION_KEY not configured' });
    return false;
  }
  if (!req.query.key || req.query.key !== MIGRATION_KEY) {
    res.status(403).json({ error: 'Invalid key' });
    return false;
  }
  return true;
};

// Main migration
router.get('/run-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [] };

  try {
    // Add all missing user columns
    const userColumns = [
      { name: 'is_approved', type: 'BOOLEAN DEFAULT true' },
      { name: 'approved_at', type: 'TIMESTAMP' },
      { name: 'approved_by', type: 'INTEGER' },
      { name: 'avatar_base64', type: 'TEXT' },
      { name: 'is_coach', type: 'BOOLEAN DEFAULT false' },
      { name: 'is_public', type: 'BOOLEAN DEFAULT true' },
      { name: 'role', type: 'TEXT' },
      { name: 'gdpr_consent', type: 'BOOLEAN DEFAULT false' },
      { name: 'gdpr_consent_date', type: 'TIMESTAMP' },
      { name: 'birthdate', type: 'DATE' }
    ];

    for (const col of userColumns) {
      try {
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        results.steps.push(`✅ Added column: ${col.name}`);
      } catch (err) {
        results.steps.push(`⏭️ Column ${col.name} already exists or error: ${err.message}`);
      }
    }

    // Set existing users as approved
    results.steps.push('Setting existing users as approved...');
    await db.query(`UPDATE users SET is_approved = true WHERE is_approved IS NULL`);

    // Make sure admins are always approved
    await db.query(`UPDATE users SET is_approved = true WHERE is_admin = true`);

    // Tricks table columns
    const trickColumns = [
      { name: 'image_url', type: 'TEXT' },
      { name: 'sections', type: "JSONB DEFAULT '[]'::jsonb" },
      { name: 'position', type: 'NUMERIC DEFAULT 0' }
    ];
    for (const col of trickColumns) {
      try {
        await db.query(`ALTER TABLE tricks ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        results.steps.push(`✅ tricks.${col.name} added`);
      } catch (err) {
        results.steps.push(`⏭️ tricks.${col.name}: ${err.message}`);
      }
    }

    // Articles image_url
    try {
      await db.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_url TEXT`);
      results.steps.push('✅ articles.image_url added');
    } catch (err) {
      results.steps.push(`⏭️ articles.image_url: ${err.message}`);
    }

    // Create demo user if not exists
    try {
      const demoExists = await db.query(`SELECT id FROM users WHERE email = 'demo@demo.demo'`);
      if (demoExists.rows.length === 0) {
        const demoPassword = await bcrypt.hash('12345', 10);
        const demoPublicId = await generatePublicId('users', 'USER');
        await db.query(
          `INSERT INTO users (public_id, email, password_hash, username, is_approved, is_admin) 
           VALUES ($1, 'demo@demo.demo', $2, 'Demo User', true, false)`,
          [demoPublicId, demoPassword]
        );
        results.steps.push('✅ Created demo user (demo@demo.demo / 12345)');
      } else {
        results.steps.push('⏭️ Demo user already exists');
      }
    } catch (demoErr) {
      results.steps.push(`⚠️ Demo user creation: ${demoErr.message}`);
    }

    results.success = true;
    results.message = '✅ Migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Birthdate migration
router.get('/run-birthdate-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [] };

  try {
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthdate DATE`);
      results.steps.push('✅ Birthdate column ready');
    } catch (err) {
      results.steps.push(`⏭️ Birthdate column: ${err.message}`);
    }

    const updateResult = await db.query(
      `UPDATE users SET birthdate = '1966-01-01' WHERE birthdate IS NULL`
    );
    results.steps.push(`✅ Updated ${updateResult.rowCount} users with default birthdate (1966-01-01)`);

    results.success = true;
    results.message = '✅ Birthdate migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// RFID migration
router.get('/run-rfid-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [] };

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS rfid_bands (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        band_uid VARCHAR(100) NOT NULL,
        assigned_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT true
      )
    `);
    results.steps.push('✅ RFID bands table created');

    try {
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rfid_bands_uid_active ON rfid_bands(band_uid) WHERE is_active = true`);
      results.steps.push('✅ Unique index on active band_uid created');
    } catch (err) {
      results.steps.push(`⚠️ Unique index: ${err.message}`);
    }

    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_rfid_bands_user_id ON rfid_bands(user_id)`);
      results.steps.push('✅ User ID index created');
    } catch (err) {
      results.steps.push(`⚠️ User ID index: ${err.message}`);
    }

    results.success = true;
    results.message = '✅ RFID migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Legacy redirect
router.get('/run-approval-migration', (req, res) => {
  res.redirect(`/api/run-migration?key=${req.query.key}`);
});

// Products migration
router.get('/run-products-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [] };

  try {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          public_id VARCHAR(50) UNIQUE NOT NULL,
          name VARCHAR(255) NOT NULL,
          category VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          description TEXT,
          duration VARCHAR(50),
          icon VARCHAR(50),
          gradient VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      results.steps.push('✅ Products table created/verified');
    } catch (err) {
      results.steps.push(`⚠️ Products table: ${err.message}`);
    }

    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS purchases (
          id SERIAL PRIMARY KEY,
          public_id VARCHAR(50) UNIQUE NOT NULL,
          user_id INTEGER REFERENCES users(id),
          product_id INTEGER REFERENCES products(id),
          quantity INTEGER DEFAULT 1,
          total_price DECIMAL(10,2) NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      results.steps.push('✅ Purchases table created/verified');
    } catch (err) {
      results.steps.push(`⚠️ Purchases table: ${err.message}`);
    }

    // Insert default products if none exist
    const productCount = await db.query('SELECT COUNT(*) FROM products');
    if (parseInt(productCount.rows[0].count) === 0) {
      const defaultProducts = [
        { name: '1h Pass', category: 'cable', price: 25.00, description: 'One hour of cable wakeboarding.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: '2h Pass', category: 'cable', price: 35.00, description: 'Two hours of cable wakeboarding.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: 'All Day', category: 'cable', price: 45.00, description: 'Unlimited riding for the entire day.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: '3 Days Pass', category: 'cable', price: 120.00, description: 'Three full days of unlimited riding.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: 'Week Pass', category: 'cable', price: 250.00, description: 'Seven days of unlimited access.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: '2 Week Pass', category: 'cable', price: 375.00, description: 'Two weeks of unlimited riding.', icon: '🎿', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: 'Water Donut & Rent 2.0', category: 'activities', price: 50.00, duration: '30min', description: 'Fun water donut ride with equipment rental.', icon: '🍩', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: '2.0 Intro Class', category: 'activities', price: 45.00, duration: '1h', description: 'Beginner introduction class.', icon: '🏫', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: 'Aquaglide 1h', category: 'activities', price: 11.00, duration: '1h', description: 'Inflatable water park access.', icon: '🎢', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: 'Kayak Single', category: 'activities', price: 11.00, duration: '1h', description: 'Single kayak rental.', icon: '🛶', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: 'SUP 1h', category: 'activities', price: 11.00, duration: '1h', description: 'Stand-up paddleboard rental.', icon: '🏄', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
        { name: 'Marbella Week', category: 'events', price: 900.00, description: 'Week-long wakeboarding trip to Marbella.', icon: '🌴', gradient: 'linear-gradient(135deg,#ec4899,#f43f5e)' },
        { name: 'Hoodie', category: 'clothes', price: 55.00, description: 'Premium quality hoodie.', icon: '🧥', gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)' },
        { name: 'Tank Top', category: 'clothes', price: 25.00, description: 'Breathable tank top.', icon: '👕', gradient: 'linear-gradient(135deg,#f43f5e,#fb923c)' },
        { name: 'T-Shirt', category: 'clothes', price: 30.00, description: 'Classic cotton t-shirt.', icon: '👚', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
        { name: 'Cap', category: 'clothes', price: 20.00, description: 'Adjustable cap.', icon: '🧢', gradient: 'linear-gradient(135deg,#10b981,#34d399)' },
      ];

      for (const product of defaultProducts) {
        try {
          const publicId = await generatePublicId('products', 'PRODUCT');
          await db.query(`
            INSERT INTO products (public_id, name, category, price, description, duration, icon, gradient, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
          `, [publicId, product.name, product.category, product.price, product.description, product.duration || null, product.icon, product.gradient]);
        } catch (insertErr) {
          results.steps.push(`⚠️ Product ${product.name}: ${insertErr.message}`);
        }
      }
      results.steps.push(`✅ Inserted ${defaultProducts.length} default products`);
    } else {
      results.steps.push(`⏭️ Products already exist (${productCount.rows[0].count} products)`);
    }

    results.success = true;
    results.message = '✅ Products migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Cart migration
router.get('/run-cart-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [] };

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, product_id)
      )
    `);
    results.steps.push('✅ Cart items table created/verified');

    results.success = true;
    results.message = '✅ Cart migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Orders migration
router.get('/run-orders-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [] };

  try {
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`);
      results.steps.push('✅ Phone column added to users');
    } catch (err) {
      results.steps.push(`⚠️ Phone column: ${err.message}`);
    }

    try {
      await db.query(`ALTER TABLE news ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
      results.steps.push('✅ User_id column added to news');
    } catch (err) {
      results.steps.push(`⚠️ News user_id column: ${err.message}`);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        public_id VARCHAR(50) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        product_category VARCHAR(50),
        amount DECIMAL(10,2) NOT NULL,
        booking_date DATE,
        booking_time VARCHAR(10),
        phone VARCHAR(30),
        shipping_address TEXT,
        status VARCHAR(50) DEFAULT 'pending_payment',
        stripe_session_id VARCHAR(255),
        stripe_payment_intent VARCHAR(255),
        fake BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    results.steps.push('✅ Orders table created');

    await db.query(`
      CREATE TABLE IF NOT EXISTS rfid_bands (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        band_uid VARCHAR(100) UNIQUE NOT NULL,
        assigned_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT true
      )
    `);
    results.steps.push('✅ RFID bands table created');

    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_rfid_bands_uid ON rfid_bands(band_uid)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_rfid_bands_user_id ON rfid_bands(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_booking_date ON orders(booking_date)`);
      results.steps.push('✅ Indexes created');
    } catch (err) {
      results.steps.push(`⚠️ Indexes: ${err.message}`);
    }

    results.success = true;
    results.message = '✅ Orders migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Users migration
router.get('/run-users-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [] };

  try {
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false`);
      results.steps.push('✅ is_blocked column added to users');
    } catch (err) {
      results.steps.push(`⚠️ is_blocked column: ${err.message}`);
    }

    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`);
      results.steps.push('✅ last_login column added to users');
    } catch (err) {
      results.steps.push(`⚠️ last_login column: ${err.message}`);
    }

    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP`);
      results.steps.push('✅ password_changed_at column added to users');
    } catch (err) {
      results.steps.push(`⚠️ password_changed_at column: ${err.message}`);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_logins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(255),
        login_time TIMESTAMP DEFAULT NOW(),
        ip_address VARCHAR(50),
        user_agent TEXT,
        success BOOLEAN DEFAULT true
      )
    `);
    results.steps.push('✅ user_logins table created');

    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_logins_user_id ON user_logins(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_logins_time ON user_logins(login_time DESC)`);
      results.steps.push('✅ Indexes created for user_logins');
    } catch (err) {
      results.steps.push(`⚠️ Indexes: ${err.message}`);
    }

    results.success = true;
    results.message = '✅ Users migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Achievements migration
router.get('/run-achievements-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [] };

  try {
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN DEFAULT false`);
      results.steps.push('✅ is_staff column added to users');
    } catch (err) {
      results.steps.push(`⚠️ is_staff column: ${err.message}`);
    }

    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_club_member BOOLEAN DEFAULT false`);
      results.steps.push('✅ is_club_member column added to users');
    } catch (err) {
      results.steps.push(`⚠️ is_club_member column: ${err.message}`);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        achievement_id VARCHAR(50) NOT NULL,
        tier VARCHAR(20) NOT NULL,
        achieved_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, achievement_id)
      )
    `);
    results.steps.push('✅ user_achievements table created');

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_manual_achievements (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        achievement_id VARCHAR(50) NOT NULL,
        awarded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        awarded_at TIMESTAMP DEFAULT NOW(),
        note TEXT,
        UNIQUE(user_id, achievement_id)
      )
    `);
    results.steps.push('✅ user_manual_achievements table created');

    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_achievements_user_id ON user_achievements(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_manual_achievements_user_id ON user_manual_achievements(user_id)`);
      results.steps.push('✅ Indexes created for achievements tables');
    } catch (err) {
      results.steps.push(`⚠️ Indexes: ${err.message}`);
    }

    results.success = true;
    results.message = '✅ Achievements migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Comments soft delete migration
router.get('/run-comments-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [], success: false };

  try {
    // Add soft delete columns to trick_comments
    const trickCommentColumns = [
      { name: 'is_deleted', type: 'BOOLEAN DEFAULT false' },
      { name: 'deleted_at', type: 'TIMESTAMP' },
      { name: 'deleted_by', type: 'INTEGER REFERENCES users(id)' }
    ];

    for (const col of trickCommentColumns) {
      try {
        await db.query(`ALTER TABLE trick_comments ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        results.steps.push(`✅ trick_comments: Added column ${col.name}`);
      } catch (err) {
        results.steps.push(`⏭️ trick_comments.${col.name}: ${err.message}`);
      }
    }

    // Add soft delete columns to achievement_comments
    const achievementCommentColumns = [
      { name: 'is_deleted', type: 'BOOLEAN DEFAULT false' },
      { name: 'deleted_at', type: 'TIMESTAMP' },
      { name: 'deleted_by', type: 'INTEGER REFERENCES users(id)' }
    ];

    for (const col of achievementCommentColumns) {
      try {
        await db.query(`ALTER TABLE achievement_comments ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        results.steps.push(`✅ achievement_comments: Added column ${col.name}`);
      } catch (err) {
        results.steps.push(`⏭️ achievement_comments.${col.name}: ${err.message}`);
      }
    }

    // Add indexes for better performance
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_trick_comments_author ON trick_comments(author_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_trick_comments_deleted ON trick_comments(is_deleted)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_achievement_comments_author ON achievement_comments(author_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_achievement_comments_deleted ON achievement_comments(is_deleted)`);
      results.steps.push('✅ Added indexes for comments');
    } catch (err) {
      results.steps.push(`⏭️ Indexes: ${err.message}`);
    }

    results.success = true;
    results.message = '✅ Comments soft delete migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// News read tracking migration
router.get('/run-news-read-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { steps: [], errors: [], success: false };

  try {
    // Create user_news_read table
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_news_read (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        news_id INTEGER REFERENCES news(id) ON DELETE CASCADE,
        read_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, news_id)
      )
    `);
    results.steps.push('✅ Created user_news_read table');

    // Add index for faster lookups
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_news_read_user ON user_news_read(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_user_news_read_news ON user_news_read(news_id)`);
      results.steps.push('✅ Added indexes');
    } catch (err) {
      results.steps.push(`⏭️ Indexes: ${err.message}`);
    }

    results.success = true;
    results.message = '✅ News read tracking migration completed!';
  } catch (error) {
    results.success = false;
    results.errors.push(error.message);
  }

  res.json(results);
});

// Migration: User News Hidden (soft delete for news)
router.get('/run-news-hidden-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  try {
    // Create user_news_hidden table
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_news_hidden (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
        hidden_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, news_id)
      )
    `);

    // Index for fast lookups
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_user_news_hidden_user_id ON user_news_hidden(user_id)
    `);

    res.json({ 
      success: true, 
      message: 'User news hidden migration completed',
      tables: ['user_news_hidden']
    });
  } catch (error) {
    console.error('News hidden migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Run ALL migrations at once
router.get('/run-all-migrations', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;

  const results = { migrations: [], success: true };

  const migrations = [
    { name: 'Main', endpoint: '/api/run-migration' },
    { name: 'Birthdate', endpoint: '/api/run-birthdate-migration' },
    { name: 'RFID', endpoint: '/api/run-rfid-migration' },
    { name: 'Products', endpoint: '/api/run-products-migration' },
    { name: 'Cart', endpoint: '/api/run-cart-migration' },
    { name: 'Orders', endpoint: '/api/run-orders-migration' },
    { name: 'Users', endpoint: '/api/run-users-migration' },
    { name: 'Achievements', endpoint: '/api/run-achievements-migration' },
    { name: 'Comments', endpoint: '/api/run-comments-migration' },
    { name: 'NewsRead', endpoint: '/api/run-news-read-migration' },
    { name: 'Feed', endpoint: '/api/run-feed-migration' },
  ];

  results.message = `Run migrations individually: ${migrations.map(m => m.endpoint).join(', ')}`;
  res.json(results);
});

// Feed migration - reactions and comments for activity feed
router.get('/run-feed-migration', async (req, res) => {
  const results = { success: false, steps: [] };
  
  if (!checkMigrationKey(req, res)) return;

  try {
    // Ensure user_tricks has updated_at column
    await db.query(`
      ALTER TABLE user_tricks 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    results.steps.push('✅ user_tricks.updated_at ensured');

    // Ensure user_tricks has created_at column
    await db.query(`
      ALTER TABLE user_tricks 
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    results.steps.push('✅ user_tricks.created_at ensured');

    // Create feed_reactions table
    await db.query(`
      CREATE TABLE IF NOT EXISTS feed_reactions (
        id SERIAL PRIMARY KEY,
        feed_item_id VARCHAR(255) NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(feed_item_id, user_id)
      )
    `);
    results.steps.push('✅ feed_reactions table created');

    // Create feed_comments table
    await db.query(`
      CREATE TABLE IF NOT EXISTS feed_comments (
        id SERIAL PRIMARY KEY,
        feed_item_id VARCHAR(255) NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    results.steps.push('✅ feed_comments table created');

    // Add indexes
    await db.query(`CREATE INDEX IF NOT EXISTS idx_feed_reactions_item ON feed_reactions(feed_item_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_feed_reactions_user ON feed_reactions(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_feed_comments_item ON feed_comments(feed_item_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_feed_comments_user ON feed_comments(user_id)`);
    results.steps.push('✅ Indexes created');

    // Ensure event_attendees has registered_at column
    await db.query(`
      ALTER TABLE event_attendees 
      ADD COLUMN IF NOT EXISTS registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    results.steps.push('✅ event_attendees.registered_at ensured');

    results.success = true;
    res.json(results);
  } catch (error) {
    console.error('Feed migration error:', error);
    results.error = error.message;
    res.status(500).json(results);
  }
});

// News comments and likes migration
router.get('/run-news-comments-migration', async (req, res) => {
  const results = { success: false, steps: [] };
  
  if (!checkMigrationKey(req, res)) return;

  try {
    // Create news_likes table
    await db.query(`
      CREATE TABLE IF NOT EXISTS news_likes (
        id SERIAL PRIMARY KEY,
        news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(news_id, user_id)
      )
    `);
    results.steps.push('✅ news_likes table created');

    // Create news_comments table
    await db.query(`
      CREATE TABLE IF NOT EXISTS news_comments (
        id SERIAL PRIMARY KEY,
        news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_deleted BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    results.steps.push('✅ news_comments table created');

    // Create news_comment_likes table
    await db.query(`
      CREATE TABLE IF NOT EXISTS news_comment_likes (
        id SERIAL PRIMARY KEY,
        comment_id INTEGER NOT NULL REFERENCES news_comments(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(comment_id, user_id)
      )
    `);
    results.steps.push('✅ news_comment_likes table created');

    // Create indexes
    await db.query(`CREATE INDEX IF NOT EXISTS idx_news_likes_news ON news_likes(news_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_news_likes_user ON news_likes(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_news_comments_news ON news_comments(news_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_news_comments_user ON news_comments(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_news_comment_likes_comment ON news_comment_likes(comment_id)`);
    results.steps.push('✅ Indexes created');

    results.success = true;
    res.json(results);
  } catch (error) {
    console.error('News comments migration error:', error);
    results.error = error.message;
    res.status(500).json(results);
  }
});

// ==================== TRICKS COLUMNS MIGRATION ====================

router.get('/run-tricks-columns-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;
  const results = { steps: [], success: false };
  try {
    await db.query(`ALTER TABLE tricks ADD COLUMN IF NOT EXISTS image_url TEXT`);
    results.steps.push('✅ tricks.image_url added');

    await db.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_url TEXT`);
    results.steps.push('✅ articles.image_url added');

    await db.query(`ALTER TABLE tricks ADD COLUMN IF NOT EXISTS sections JSONB DEFAULT '[]'::jsonb`);
    results.steps.push('✅ tricks.sections added');

    await db.query(`ALTER TABLE tricks ADD COLUMN IF NOT EXISTS position NUMERIC DEFAULT 0`);
    results.steps.push('✅ tricks.position added');

    results.success = true;
    res.json(results);
  } catch (error) {
    console.error('Tricks columns migration error:', error);
    results.error = error.message;
    res.status(500).json(results);
  }
});

// Shop categories migration: cable→coaching, activities→camps, events→camps, clothes stays, add stay_travel
router.get('/run-shop-categories-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;
  const results = { steps: [] };
  try {
    // Remap existing categories
    const mappings = [
      { from: 'cable', to: 'coaching' },
      { from: 'activities', to: 'camps' },
      { from: 'events', to: 'camps' },
      // 'clothes' stays as 'clothes'
    ];
    for (const m of mappings) {
      const r = await db.query(
        `UPDATE products SET category = $1 WHERE category = $2`,
        [m.to, m.from]
      );
      results.steps.push(`${m.from} → ${m.to}: ${r.rowCount} products updated`);
    }

    // Insert 3 example products per category if categories are empty
    const exampleProducts = [
      // Coaching (3)
      { name: 'Private Coaching 1h', category: 'coaching', price: 65.00, description: 'One-on-one session with a certified cable coach. All levels welcome.', duration: '1h', icon: '🎯' },
      { name: 'Group Lesson (4 pax)', category: 'coaching', price: 35.00, description: 'Small group coaching session. Perfect for friends learning together.', duration: '1.5h', icon: '👥' },
      { name: 'Video Analysis Session', category: 'coaching', price: 45.00, description: 'Record your session and review with coach. Includes slow-mo breakdown.', duration: '1h', icon: '📹' },
      // Camps (3)
      { name: 'Weekend Camp', category: 'camps', price: 199.00, description: 'Two full days of coaching, sessions, and park activities. Lunch included.', duration: '2 days', icon: '⛺' },
      { name: 'Summer Week Camp', category: 'camps', price: 549.00, description: 'Five-day intensive wakeboard camp with accommodation and full board.', duration: '5 days', icon: '☀️' },
      { name: 'Kids Camp (8-14)', category: 'camps', price: 159.00, description: 'Fun camp for kids with safe equipment, games and supervised sessions.', duration: '3 days', icon: '🧒' },
      // Clothes (3)
      { name: 'Classic Tee', category: 'clothes', price: 29.00, description: 'Lunar Cable Park logo t-shirt. 100% organic cotton.', icon: '👕', gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)' },
      { name: 'Park Hoodie', category: 'clothes', price: 55.00, description: 'Premium heavyweight hoodie with embroidered logo.', icon: '🧥', gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)' },
      { name: 'Snapback Cap', category: 'clothes', price: 22.00, description: 'Adjustable snapback cap with woven patch.', icon: '🧢', gradient: 'linear-gradient(135deg,#10b981,#34d399)' },
      // Stay/Car (3)
      { name: 'Glamping Tent (2 nights)', category: 'stay_travel', price: 120.00, description: 'Furnished tent next to the park with bed, lights and power.', duration: '2 nights', icon: '⛺' },
      { name: 'Apartment Cuevas (weekly)', category: 'stay_travel', price: 350.00, description: 'Full apartment in Cuevas del Almanzora, 5 min from the park.', duration: '7 nights', icon: '🏠' },
      { name: 'Car Rental (daily)', category: 'stay_travel', price: 35.00, description: 'Economy car rental. Pick up at park or Almería airport.', duration: '1 day', icon: '🚗' },
    ];

    let inserted = 0;
    for (const p of exampleProducts) {
      // Only insert if no product with same name exists
      const exists = await db.query('SELECT id FROM products WHERE name = $1', [p.name]);
      if (exists.rows.length === 0) {
        const publicId = await generatePublicId('products', 'PROD');
        await db.query(
          `INSERT INTO products (public_id, name, category, price, description, duration, icon, gradient, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [publicId, p.name, p.category, p.price, p.description, p.duration || null, p.icon, p.gradient || null]
        );
        inserted++;
      }
    }
    results.steps.push(`Inserted ${inserted} example products (skipped ${exampleProducts.length - inserted} existing)`);

    // Log final category distribution
    const dist = await db.query(`SELECT category, COUNT(*) as count FROM products GROUP BY category ORDER BY category`);
    results.distribution = dist.rows;
    results.success = true;
    res.json(results);
  } catch (error) {
    console.error('Shop categories migration error:', error);
    results.error = error.message;
    res.status(500).json(results);
  }
});

// Partners migration: create table + social fields + 2 default partners
router.get('/run-partners-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;
  const results = { steps: [] };
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100),
        website_url TEXT,
        image_url TEXT,
        icon VARCHAR(50) DEFAULT '🤝',
        gradient VARCHAR(255),
        position INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        facebook_url TEXT,
        instagram_url TEXT,
        linkedin_url TEXT,
        tiktok_url TEXT,
        youtube_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    results.steps.push('✅ Partners table created');

    // Add social columns if missing (idempotent)
    const socialCols = ['facebook_url','instagram_url','linkedin_url','tiktok_url','youtube_url'];
    for (const col of socialCols) {
      await db.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS ${col} TEXT`);
    }
    results.steps.push('✅ Social columns ensured');

    // Fix old category values: 'sponsor' → 'sponsors'
    await db.query(`UPDATE partners SET category = 'sponsors' WHERE category = 'sponsor'`);
    results.steps.push('✅ Fixed legacy category values');

    await db.query(`CREATE INDEX IF NOT EXISTS idx_partners_active ON partners(is_active)`);
    results.steps.push('✅ Index created');

    // Backfill social URLs for any partners that don't have them
    const updated = await db.query(`UPDATE partners SET 
      facebook_url = COALESCE(facebook_url, 'https://www.lunarcablepark.com'),
      instagram_url = COALESCE(instagram_url, 'https://www.lunarcablepark.com'),
      linkedin_url = COALESCE(linkedin_url, 'https://www.lunarcablepark.com'),
      tiktok_url = COALESCE(tiktok_url, 'https://www.lunarcablepark.com'),
      youtube_url = COALESCE(youtube_url, 'https://www.lunarcablepark.com')
      WHERE facebook_url IS NULL OR instagram_url IS NULL OR linkedin_url IS NULL OR tiktok_url IS NULL OR youtube_url IS NULL`);
    results.steps.push(`✅ Backfilled social URLs (${updated.rowCount} rows updated)`);

    // Invalidate cache so changes are visible immediately
    cache.invalidatePrefix('partners');

    // Insert 2 default partners if table is empty
    const count = await db.query('SELECT COUNT(*) FROM partners');
    if (parseInt(count.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO partners (name, description, category, icon, gradient, position, is_active, website_url, facebook_url, instagram_url, linkedin_url, tiktok_url, youtube_url) VALUES
        ('Partner 1', 'Our first amazing partner. Tap to learn more about them.', 'sponsors', '🤝', 'linear-gradient(135deg,#3b82f6,#06b6d4)', 1, true, 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com'),
        ('Partner 2', 'Our second incredible partner. Great things together.', 'sponsors', '⭐', 'linear-gradient(135deg,#f59e0b,#fbbf24)', 2, true, 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com')
      `);
      results.steps.push('✅ Inserted 2 default partners');
    } else {
      results.steps.push(`⏭️ Partners already exist (${count.rows[0].count})`);
    }

    results.success = true;
    res.json(results);
  } catch (error) {
    console.error('Partners migration error:', error);
    results.error = error.message;
    res.status(500).json(results);
  }
});

// Parks migration: create table + default Lunar Cable Park
router.get('/run-parks-migration', async (req, res) => {
  if (!checkMigrationKey(req, res)) return;
  const results = { steps: [] };
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS parks (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        address TEXT,
        website_url TEXT,
        image_url TEXT,
        icon VARCHAR(50) DEFAULT '🏞️',
        gradient VARCHAR(255),
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        position INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        facebook_url TEXT,
        instagram_url TEXT,
        linkedin_url TEXT,
        tiktok_url TEXT,
        youtube_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    results.steps.push('✅ Parks table created');

    await db.query(`CREATE INDEX IF NOT EXISTS idx_parks_active ON parks(is_active)`);
    results.steps.push('✅ Index created');

    const count = await db.query('SELECT COUNT(*) FROM parks');
    if (parseInt(count.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO parks (name, description, address, website_url, icon, gradient, latitude, longitude, position, is_active, facebook_url, instagram_url, linkedin_url, tiktok_url, youtube_url) VALUES
        ('Lunar Cable Park', 'The first cable wakeboard park in Almería. Crystal clear water, perfect conditions all year round.', 'Ctra. el Pantano, Pol. 12. 04610, Cuevas del Almanzora, Almería', 'https://www.lunarcablepark.com', '🌙', 'linear-gradient(135deg,#3b82f6,#06b6d4)', 37.3225, -1.8988, 1, true, 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com', 'https://www.lunarcablepark.com')
      `);
      results.steps.push('✅ Inserted default Lunar Cable Park');
    } else {
      results.steps.push(`⏭️ Parks already exist (${count.rows[0].count})`);
    }

    results.success = true;
    res.json(results);
  } catch (error) {
    console.error('Parks migration error:', error);
    results.error = error.message;
    res.status(500).json(results);
  }
});

module.exports = router;
