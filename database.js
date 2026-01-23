const { Pool } = require('pg');

// Railway automatycznie ustawia DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Query helper
const query = (text, params) => pool.query(text, params);

// Initialize database tables
const initDatabase = async () => {
  try {
    await pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT,
        avatar_url TEXT,
        is_admin BOOLEAN DEFAULT FALSE,
        is_coach BOOLEAN DEFAULT FALSE,
        is_public BOOLEAN DEFAULT TRUE,
        role TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Tricks table
      CREATE TABLE IF NOT EXISTS tricks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        description TEXT,
        full_description TEXT,
        video_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- User tricks progress
      CREATE TABLE IF NOT EXISTS user_tricks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        trick_id INTEGER NOT NULL REFERENCES tricks(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'todo',
        notes TEXT,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, trick_id)
      );

      -- Events table
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        location TEXT NOT NULL,
        location_url TEXT,
        spots INTEGER DEFAULT 10,
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Event attendees
      CREATE TABLE IF NOT EXISTS event_attendees (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(event_id, user_id)
      );

      -- News table
      CREATE TABLE IF NOT EXISTS news (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        message TEXT,
        type TEXT DEFAULT 'info',
        emoji TEXT,
        event_details JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Database tables created');

    // Seed data if empty
    await seedData();

  } catch (error) {
    console.error('Database init error:', error);
    throw error;
  }
};

// Seed initial data
const seedData = async () => {
  try {
    // Check if tricks exist
    const tricksResult = await pool.query('SELECT COUNT(*) FROM tricks');
    if (parseInt(tricksResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO tricks (name, category, difficulty, description, full_description, video_url) VALUES
        ('Getting Started', 'preparation', 'beginner', 'Learn the basics before hitting the water.', 'Before you start wakeboarding, understand the equipment, safety, and fundamentals.', NULL),
        ('Surface 180', 'surface', 'beginner', 'A half rotation on the water surface.', 'Start by riding with comfortable speed. Initiate rotation by turning head and shoulders.', 'https://grabby.s3.eu-west-3.amazonaws.com/fwt/tricks/7ce820c0-dad7-406f-9ba5-5161be72c07a-video#t=0.001'),
        ('Wake Jump', 'air', 'beginner', 'Basic jump using the wake as a ramp.', 'Approach wake with progressive edge. Keep knees bent and handle low.', NULL),
        ('Kicker 180', 'kicker', 'intermediate', 'Half rotation off a kicker.', 'Approach ramp with moderate speed. Stay centered as you ride up.', NULL),
        ('50-50 Grind', 'rail', 'beginner', 'Ride straight across the rail.', 'Pop onto rail and center weight over middle of board.', NULL)
      `);
      console.log('✅ Seeded tricks');
    }

    // Check if events exist
    const eventsResult = await pool.query('SELECT COUNT(*) FROM events');
    if (parseInt(eventsResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO events (name, date, time, location, location_url, spots) VALUES
        ('Morning Ride', '2026-01-25', '10:00', 'Flat Water', 'https://www.flatwater.space', 8),
        ('Afternoon Session', '2026-01-26', '14:00', 'Flat Water', 'https://www.flatwater.space', 10),
        ('Pro Training', '2026-01-28', '09:00', 'Lunar Cable Park', 'https://www.lunarcablepark.com', 6),
        ('Weekend Wakeboard', '2026-02-07', '11:00', 'Flat Water', 'https://www.flatwater.space', 12)
      `);
      console.log('✅ Seeded events');
    }

    // Check if news exist
    const newsResult = await pool.query('SELECT COUNT(*) FROM news');
    if (parseInt(newsResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO news (title, message, type, emoji, event_details) VALUES
        ('Wings for Life World Run', 'Run for those who cant!', 'event', '🏃', '{"description": "Join thousands worldwide in this unique charity run.", "date": "2026-05-03", "time": "13:00", "location": "Flat Water", "price": "€25"}'),
        ('Summer Camp 2026', 'Early bird pricing ends soon!', 'event', '🏕️', '{"description": "5-day intensive wakeboarding camp. All levels welcome.", "date": "2026-07-15", "time": "9:00-17:00", "location": "Flat Water", "price": "€239"}')
      `);
      console.log('✅ Seeded news');
    }

  } catch (error) {
    console.error('Seed data error:', error);
  }
};

module.exports = {
  query,
  initDatabase,
  pool
};
