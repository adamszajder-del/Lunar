// Migrations Routes - /api/run-*-migration
const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcryptjs');
const { generatePublicId } = require('../utils/publicId');
const config = require('../config');

const MIGRATION_KEY = config.MIGRATION_KEY || 'lunar2025';

// Main migration
router.get('/run-migration', async (req, res) => {
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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

// Run ALL migrations at once
router.get('/run-all-migrations', async (req, res) => {
  if (req.query.key !== MIGRATION_KEY) {
    return res.status(403).json({ error: 'Invalid key' });
  }

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
  ];

  results.message = `Run migrations individually or use endpoints: ${migrations.map(m => m.endpoint + '?key=' + MIGRATION_KEY).join(', ')}`;
  res.json(results);
});

module.exports = router;
