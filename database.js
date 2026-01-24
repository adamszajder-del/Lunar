const { Pool } = require('pg');

// Use DATABASE_URL from Railway or local config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const query = (text, params) => pool.query(text, params);

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
      is_public BOOLEAN DEFAULT true,
      role TEXT,
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

  console.log('✅ Database initialized');
};

module.exports = { query, initDatabase };
