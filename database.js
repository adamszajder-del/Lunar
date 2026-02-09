const { Pool } = require('pg');
// Use DATABASE_URL from Railway or local config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
const query = (text, params) => pool.query(text, params);
const getClient = () => pool.connect(); // For transactions
const initDatabase = async () => {
  console.log('🔄 Initializing database...');
  // Users table
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      public_id TEXT UNIQUE,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      avatar_base64 TEXT,
      is_admin BOOLEAN DEFAULT false,
      is_coach BOOLEAN DEFAULT false,
      is_staff BOOLEAN DEFAULT false,
      is_club_member BOOLEAN DEFAULT false,
      is_public BOOLEAN DEFAULT true,
      is_approved BOOLEAN DEFAULT false,
      is_blocked BOOLEAN DEFAULT false,
      role TEXT,
      birthdate DATE,
      gdpr_consent BOOLEAN DEFAULT false,
      phone VARCHAR(50),
      last_login TIMESTAMP,
      reset_token VARCHAR(255),
      reset_token_expires TIMESTAMP,
      password_changed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Tricks table
  await query(`
    CREATE TABLE IF NOT EXISTS tricks (
      id SERIAL PRIMARY KEY,
      public_id TEXT UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      description TEXT,
      full_description TEXT,
      video_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // User tricks progress
  await query(`
    CREATE TABLE IF NOT EXISTS user_tricks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      trick_id INTEGER REFERENCES tricks(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'todo',
      notes TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, trick_id)
    )
  `);
  // Events table
  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      public_id TEXT UNIQUE,
      name TEXT NOT NULL,
      date DATE NOT NULL,
      time TEXT NOT NULL,
      location TEXT NOT NULL,
      location_url TEXT,
      spots INTEGER DEFAULT 10,
      author_id INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Event attendees
  await query(`
    CREATE TABLE IF NOT EXISTS event_attendees (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      registered_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(event_id, user_id)
    )
  `);
  // News table
  await query(`
    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      public_id TEXT UNIQUE,
      title TEXT NOT NULL,
      message TEXT,
      type TEXT DEFAULT 'info',
      emoji TEXT,
      event_details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Articles table - for Learn section
  await query(`
    CREATE TABLE IF NOT EXISTS articles (
      id SERIAL PRIMARY KEY,
      public_id TEXT UNIQUE,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      content TEXT,
      read_time TEXT DEFAULT '5 min',
      author_id INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // User articles progress (fresh/to_read/known)
  await query(`
    CREATE TABLE IF NOT EXISTS user_articles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'fresh',
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, article_id)
    )
  `);
  // User favorites (tricks, articles, users)
  await query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, item_type, item_id)
    )
  `);
  // Trick likes (social feature)
  await query(`
    CREATE TABLE IF NOT EXISTS trick_likes (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trick_id INTEGER NOT NULL REFERENCES tricks(id) ON DELETE CASCADE,
      liker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(owner_id, trick_id, liker_id)
    )
  `);
  // Trick comments (social feature)
  await query(`
    CREATE TABLE IF NOT EXISTS trick_comments (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trick_id INTEGER NOT NULL REFERENCES tricks(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      is_deleted BOOLEAN DEFAULT false,
      deleted_at TIMESTAMP,
      deleted_by INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Comment likes (social feature)
  await query(`
    CREATE TABLE IF NOT EXISTS comment_likes (
      id SERIAL PRIMARY KEY,
      comment_id INTEGER NOT NULL REFERENCES trick_comments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(comment_id, user_id)
    )
  `);
  // Achievement likes (social feature)
  await query(`
    CREATE TABLE IF NOT EXISTS achievement_likes (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      achievement_id TEXT NOT NULL,
      liker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(owner_id, achievement_id, liker_id)
    )
  `);
  // Achievement comments (social feature)
  await query(`
    CREATE TABLE IF NOT EXISTS achievement_comments (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      achievement_id TEXT NOT NULL,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      is_deleted BOOLEAN DEFAULT false,
      deleted_at TIMESTAMP,
      deleted_by INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Achievement comment likes
  await query(`
    CREATE TABLE IF NOT EXISTS achievement_comment_likes (
      id SERIAL PRIMARY KEY,
      comment_id INTEGER NOT NULL REFERENCES achievement_comments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(comment_id, user_id)
    )
  `);
  
  // Notifications table (social feature)
  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT,
      target_id INTEGER,
      target_name TEXT,
      message TEXT,
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  // Notification grouping table (for aggregating similar notifications)
  await query(`
    CREATE TABLE IF NOT EXISTS notification_groups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      count INTEGER DEFAULT 1,
      last_actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, type, target_type, target_id)
    )
  `);
  
  // Indexes for trick reactions
  try {
    await query(`CREATE INDEX IF NOT EXISTS idx_trick_likes_owner_trick ON trick_likes(owner_id, trick_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_trick_comments_owner_trick ON trick_comments(owner_id, trick_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_achievement_likes_owner ON achievement_likes(owner_id, achievement_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_achievement_comments_owner ON achievement_comments(owner_id, achievement_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_notification_groups_user ON notification_groups(user_id, is_read)`);
  } catch (e) { /* indexes may already exist */ }

  // User achievements (needed by feed, profile)
  await query(`
    CREATE TABLE IF NOT EXISTS user_achievements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      achievement_id VARCHAR(100) NOT NULL,
      tier VARCHAR(20) DEFAULT 'bronze',
      achieved_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, achievement_id)
    )
  `);

  // User manual achievements (granted by admin)
  await query(`
    CREATE TABLE IF NOT EXISTS user_manual_achievements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      achievement_id VARCHAR(100) NOT NULL,
      awarded_by INTEGER REFERENCES users(id),
      note TEXT,
      awarded_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, achievement_id)
    )
  `);

  // Feed reactions
  await query(`
    CREATE TABLE IF NOT EXISTS feed_reactions (
      id SERIAL PRIMARY KEY,
      feed_item_id VARCHAR(255) NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(feed_item_id, user_id)
    )
  `);

  // Feed comments
  await query(`
    CREATE TABLE IF NOT EXISTS feed_comments (
      id SERIAL PRIMARY KEY,
      feed_item_id VARCHAR(255) NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // RFID bands
  await query(`
    CREATE TABLE IF NOT EXISTS rfid_bands (
      id SERIAL PRIMARY KEY,
      band_uid VARCHAR(100) NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      is_active BOOLEAN DEFAULT true,
      assigned_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Products
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      public_id VARCHAR(50) UNIQUE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      category VARCHAR(100),
      image_url TEXT,
      stripe_price_id VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Orders
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      public_id VARCHAR(50) UNIQUE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      product_id INTEGER,
      product_name VARCHAR(255),
      product_category VARCHAR(100),
      amount DECIMAL(10,2),
      booking_date DATE,
      booking_time VARCHAR(20),
      phone VARCHAR(50),
      shipping_address TEXT,
      status VARCHAR(50) DEFAULT 'pending_payment',
      stripe_session_id VARCHAR(255),
      stripe_payment_intent VARCHAR(255),
      fake BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Cart items
  await query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, product_id)
    )
  `);

  // User logins (audit)
  await query(`
    CREATE TABLE IF NOT EXISTS user_logins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(255),
      login_time TIMESTAMP DEFAULT NOW(),
      ip_address VARCHAR(100),
      user_agent TEXT,
      success BOOLEAN DEFAULT true
    )
  `);

  // User news read
  await query(`
    CREATE TABLE IF NOT EXISTS user_news_read (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      news_id INTEGER REFERENCES news(id) ON DELETE CASCADE,
      read_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, news_id)
    )
  `);

  // User news hidden (soft delete for user)
  await query(`
    CREATE TABLE IF NOT EXISTS user_news_hidden (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      news_id INTEGER REFERENCES news(id) ON DELETE CASCADE,
      hidden_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, news_id)
    )
  `);

  // News likes
  await query(`
    CREATE TABLE IF NOT EXISTS news_likes (
      id SERIAL PRIMARY KEY,
      news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(news_id, user_id)
    )
  `);

  // News comments
  await query(`
    CREATE TABLE IF NOT EXISTS news_comments (
      id SERIAL PRIMARY KEY,
      news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      is_deleted BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // News comment likes
  await query(`
    CREATE TABLE IF NOT EXISTS news_comment_likes (
      id SERIAL PRIMARY KEY,
      comment_id INTEGER NOT NULL REFERENCES news_comments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(comment_id, user_id)
    )
  `);

  // Additional indexes
  try {
    await query(`CREATE INDEX IF NOT EXISTS idx_user_achievements_user_id ON user_achievements(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_feed_reactions_item ON feed_reactions(feed_item_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_feed_comments_item ON feed_comments(feed_item_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_rfid_bands_uid ON rfid_bands(band_uid)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_news_likes_news ON news_likes(news_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_news_comments_news ON news_comments(news_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_news_comment_likes_comment ON news_comment_likes(comment_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_user_news_hidden_user ON user_news_hidden(user_id)`);
  } catch (e) { /* indexes may already exist */ }

  console.log('✅ Database initialized');
};
module.exports = { query, getClient, initDatabase };
