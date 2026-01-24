const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: '*', // Pozwól na połączenia z każdej domeny (frontend na home.pl)
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// ==================== AUTH ROUTES ====================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'wakeway-secret-key-change-in-production';

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;
    
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, password and username are required' });
    }

    // Check if user exists
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate public_id
    const publicId = await generatePublicId('users', 'USER');

    // Create user
    const result = await db.query(
      'INSERT INTO users (public_id, email, password_hash, username) VALUES ($1, $2, $3, $4) RETURNING id, public_id, email, username',
      [publicId, email, passwordHash, username]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ user, token });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        username: user.username,
        is_admin: user.is_admin
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Auth middleware
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await db.query('SELECT id, public_id, email, username, is_admin FROM users WHERE id = $1', [decoded.userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ==================== TRICKS ROUTES ====================

// Get all tricks
app.get('/api/tricks', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM tricks ORDER BY category, difficulty');
    res.json(result.rows);
  } catch (error) {
    console.error('Get tricks error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's trick progress
app.get('/api/tricks/progress', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT trick_id, status, notes FROM user_tricks WHERE user_id = $1',
      [req.user.id]
    );
    
    // Convert to object format { trickId: { status, notes } }
    const progress = {};
    result.rows.forEach(row => {
      progress[row.trick_id] = { status: row.status, notes: row.notes };
    });
    
    res.json(progress);
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update trick progress
app.post('/api/tricks/progress', authMiddleware, async (req, res) => {
  try {
    const { trickId, status, notes } = req.body;

    await db.query(`
      INSERT INTO user_tricks (user_id, trick_id, status, notes)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, trick_id)
      DO UPDATE SET status = $3, notes = $4, updated_at = NOW()
    `, [req.user.id, trickId, status, notes || '']);

    res.json({ success: true });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN TRICKS ROUTES ====================

// Create trick (admin)
app.post('/api/admin/tricks', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, category, difficulty, description, full_description, video_url } = req.body;
    const publicId = await generatePublicId('tricks', 'TRICK');

    const result = await db.query(
      `INSERT INTO tricks (public_id, name, category, difficulty, description, full_description, video_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [publicId, name, category, difficulty, description || '', full_description || '', video_url || null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create trick error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update trick (admin)
app.put('/api/admin/tricks/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, category, difficulty, description, full_description, video_url } = req.body;

    const result = await db.query(
      `UPDATE tricks SET name = $1, category = $2, difficulty = $3, description = $4, full_description = $5, video_url = $6
       WHERE id = $7 RETURNING *`,
      [name, category, difficulty, description, full_description, video_url, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update trick error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete trick (admin)
app.delete('/api/admin/tricks/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM tricks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete trick error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== EVENTS ROUTES ====================

// Get all events
app.get('/api/events', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.*, 
             u.username as author_name,
             (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendees
      FROM events e
      LEFT JOIN users u ON e.author_id = u.id
      ORDER BY e.date, e.time
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's registered events
app.get('/api/events/registered', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT event_id FROM event_attendees WHERE user_id = $1',
      [req.user.id]
    );
    res.json(result.rows.map(r => r.event_id));
  } catch (error) {
    console.error('Get registered events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Register for event
app.post('/api/events/:id/register', authMiddleware, async (req, res) => {
  try {
    const eventId = req.params.id;

    // Check if already registered
    const existing = await db.query(
      'SELECT id FROM event_attendees WHERE event_id = $1 AND user_id = $2',
      [eventId, req.user.id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Already registered' });
    }

    // Check spots
    const event = await db.query('SELECT spots FROM events WHERE id = $1', [eventId]);
    const attendees = await db.query('SELECT COUNT(*) as count FROM event_attendees WHERE event_id = $1', [eventId]);

    if (attendees.rows[0].count >= event.rows[0].spots) {
      return res.status(400).json({ error: 'Event is full' });
    }

    await db.query(
      'INSERT INTO event_attendees (event_id, user_id) VALUES ($1, $2)',
      [eventId, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Register event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unregister from event
app.delete('/api/events/:id/register', authMiddleware, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM event_attendees WHERE event_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Unregister event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN EVENTS ROUTES ====================

// Get all events (admin)
app.get('/api/admin/events', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.*, 
             u.username as author_username,
             (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendees
      FROM events e
      LEFT JOIN users u ON e.author_id = u.id
      ORDER BY e.date DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get admin events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create event (admin)
app.post('/api/admin/events', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, date, time, location, location_url, spots } = req.body;
    const publicId = await generatePublicId('events', 'EVENT');

    const result = await db.query(
      `INSERT INTO events (public_id, name, date, time, location, location_url, spots, author_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [publicId, name, date, time, location, location_url || null, spots || 10, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update event (admin)
app.put('/api/admin/events/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, date, time, location, location_url, spots } = req.body;

    const result = await db.query(
      `UPDATE events SET name = $1, date = $2, time = $3, location = $4, location_url = $5, spots = $6
       WHERE id = $7 RETURNING *`,
      [name, date, time, location, location_url, spots, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete event (admin)
app.delete('/api/admin/events/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== USERS/CREW ROUTES ====================

// Get all crew members (public profiles)
app.get('/api/users/crew', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, username, display_name, avatar_url, is_coach, role,
             (SELECT COUNT(*) FROM user_tricks WHERE user_id = users.id AND status = 'mastered') as mastered,
             (SELECT COUNT(*) FROM user_tricks WHERE user_id = users.id AND status = 'in_progress') as in_progress
      FROM users
      WHERE is_public = true
      ORDER BY is_coach DESC, username
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get crew error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN USERS ROUTES ====================

// Get all users (admin)
app.get('/api/admin/users', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, email, username, display_name, is_admin, created_at 
      FROM users ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create user (admin)
app.post('/api/admin/users', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, password, username, display_name, is_admin } = req.body;
    const passwordHash = await bcrypt.hash(password, 10);
    const publicId = await generatePublicId('users', 'USER');

    const result = await db.query(
      `INSERT INTO users (public_id, email, password_hash, username, display_name, is_admin) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, public_id, email, username, display_name, is_admin, created_at`,
      [publicId, email, passwordHash, username, display_name || null, is_admin || false]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (admin)
app.put('/api/admin/users/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, password, username, display_name, is_admin } = req.body;
    
    let query, params;
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      query = `UPDATE users SET email = $1, password_hash = $2, username = $3, display_name = $4, is_admin = $5
               WHERE id = $6 RETURNING id, public_id, email, username, display_name, is_admin, created_at`;
      params = [email, passwordHash, username, display_name, is_admin, req.params.id];
    } else {
      query = `UPDATE users SET email = $1, username = $2, display_name = $3, is_admin = $4
               WHERE id = $5 RETURNING id, public_id, email, username, display_name, is_admin, created_at`;
      params = [email, username, display_name, is_admin, req.params.id];
    }

    const result = await db.query(query, params);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin)
app.delete('/api/admin/users/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== NEWS ROUTES ====================

// Get all news
app.get('/api/news', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM news ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN NEWS ROUTES ====================

// Create news (admin)
app.post('/api/admin/news', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { title, message, type, emoji, event_details } = req.body;
    const publicId = await generatePublicId('news', 'NEWS');

    const result = await db.query(
      `INSERT INTO news (public_id, title, message, type, emoji, event_details) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [publicId, title, message || '', type || 'info', emoji || null, event_details ? JSON.stringify(event_details) : null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update news (admin)
app.put('/api/admin/news/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { title, message, type, emoji, event_details } = req.body;

    const result = await db.query(
      `UPDATE news SET title = $1, message = $2, type = $3, emoji = $4, event_details = $5
       WHERE id = $6 RETURNING *`,
      [title, message, type, emoji, event_details ? JSON.stringify(event_details) : null, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete news (admin)
app.delete('/api/admin/news/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM news WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete news error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ARTICLES ROUTES ====================

// Get all articles
app.get('/api/articles', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.*, u.username as author_username
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id
      ORDER BY a.category, a.title
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get articles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN ARTICLES ROUTES ====================

// Create article (admin)
app.post('/api/admin/articles', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { category, title, description, content, read_time } = req.body;
    const publicId = await generatePublicId('articles', 'ARTICLE');

    const result = await db.query(
      `INSERT INTO articles (public_id, category, title, description, content, read_time, author_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [publicId, category, title, description || '', content || '', read_time || '5 min', req.user.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update article (admin)
app.put('/api/admin/articles/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { category, title, description, content, read_time } = req.body;

    const result = await db.query(
      `UPDATE articles SET category = $1, title = $2, description = $3, content = $4, read_time = $5
       WHERE id = $6 RETURNING *`,
      [category, title, description, content, read_time, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete article (admin)
app.delete('/api/admin/articles/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM articles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete article error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== PUBLIC ID GENERATOR ====================

async function generatePublicId(tableName, prefix) {
  try {
    const result = await db.query(
      `SELECT public_id FROM ${tableName} WHERE public_id LIKE $1 ORDER BY public_id DESC LIMIT 1`,
      [`${prefix}-%`]
    );
    
    let nextNum = 1;
    if (result.rows.length > 0 && result.rows[0].public_id) {
      const currentNum = parseInt(result.rows[0].public_id.split('-')[1], 10);
      nextNum = currentNum + 1;
    }
    
    return `${prefix}-${String(nextNum).padStart(5, '0')}`;
  } catch (error) {
    console.error('Generate public_id error:', error);
    return `${prefix}-${Date.now()}`;
  }
}

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== MIGRATION ENDPOINT ====================
// Usage: /api/run-migration?key=lunar2025
// Remove after use!

app.get('/api/run-migration', async (req, res) => {
  if (req.query.key !== 'lunar2025') {
    return res.status(403).json({ error: 'Invalid key. Use ?key=lunar2025' });
  }

  const results = { steps: [], errors: [], summary: {} };

  try {
    // STEP 1: Add public_id columns
    results.steps.push('Step 1: Adding public_id columns...');
    
    const tables = [
      { name: 'users', prefix: 'USER' },
      { name: 'tricks', prefix: 'TRICK' },
      { name: 'events', prefix: 'EVENT' },
      { name: 'articles', prefix: 'ARTICLE' },
      { name: 'news', prefix: 'NEWS' }
    ];

    for (const table of tables) {
      try {
        // Check if column exists
        const colCheck = await db.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = $1 AND column_name = 'public_id'
        `, [table.name]);

        if (colCheck.rows.length === 0) {
          await db.query(`ALTER TABLE ${table.name} ADD COLUMN public_id TEXT UNIQUE`);
          results.steps.push(`  ✅ Added public_id to ${table.name}`);
        } else {
          results.steps.push(`  ⏭️ ${table.name} already has public_id`);
        }
      } catch (err) {
        results.errors.push(`Error with ${table.name}: ${err.message}`);
      }
    }

    // STEP 2: Add missing tricks
    results.steps.push('Step 2: Adding missing tricks...');

    const allTricks = [
      ['Getting Started', 'preparation', 'beginner', 'Learn the basics before hitting the water.', 'Before you start wakeboarding, understand the equipment, safety, and fundamentals.'],
      ['Deep Water Start', 'preparation', 'beginner', 'Master the essential water start technique.', 'Float in the water with knees to chest, arms straight.'],
      ['Dock Start', 'preparation', 'intermediate', 'Start directly from the dock platform.', 'Sit on dock edge with feet in bindings.'],
      ['Falling Safely', 'preparation', 'beginner', 'Learn how to fall without getting hurt.', 'Let go of handle immediately. Protect face with arms crossed.'],
      ['Riding Switch', 'preparation', 'intermediate', 'Ride comfortably with non-dominant foot forward.', 'Practice riding with opposite foot forward.'],
      ['Surface 180', 'surface', 'beginner', 'A half rotation on the water surface.', 'Start with handle at hip. Look over shoulder.'],
      ['Surface 360', 'surface', 'intermediate', 'Full rotation on the water surface.', 'Commit to the spin. Pass handle behind your back at 180.'],
      ['Butterslide', 'surface', 'beginner', 'Slide sideways across the water.', 'Turn board perpendicular to direction.'],
      ['Nose Press', 'surface', 'intermediate', 'Ride with weight shifted to the nose.', 'Shift weight forward to lift tail.'],
      ['Tail Press', 'surface', 'intermediate', 'Ride with weight shifted to the tail.', 'Shift weight to back foot, lifting the nose.'],
      ['Power Slide', 'surface', 'intermediate', 'Aggressive sliding turn on the water.', 'Carve hard then release edge.'],
      ['Revert', 'surface', 'intermediate', 'Quick 180 to switch and back.', 'Perform a surface 180, then immediately spin back.'],
      ['No-Hander', 'surface', 'beginner', 'Release the handle while riding.', 'While riding stable, let go with one hand, then both.'],
      ['Wake Jump', 'air', 'beginner', 'Basic jump using the wake as a ramp.', 'Approach wake with progressive edge.'],
      ['Ollie', 'air', 'intermediate', 'Jump without using the wake.', 'Shift weight to tail, spring up.'],
      ['Tantrum', 'air', 'advanced', 'Backflip off the wake.', 'Cut hard into wake, stand tall at the lip.'],
      ['Raley', 'air', 'advanced', 'Superman-style air trick.', 'Edge hard into wake. At lip, resist with straight arms.'],
      ['Grab Indy', 'air', 'intermediate', 'Grab the toe edge between your feet.', 'Get good air first. Bring knees up.'],
      ['Grab Melon', 'air', 'intermediate', 'Grab heelside edge with front hand.', 'Get air, pull knees up.'],
      ['Grab Stalefish', 'air', 'advanced', 'Reach behind to grab heelside edge.', 'Jump and bring board up.'],
      ['Backroll', 'air', 'advanced', 'Cartwheel-style rotation off the wake.', 'Cut into wake on heelside.'],
      ['Kicker 180', 'kicker', 'intermediate', 'Half rotation off a kicker.', 'Approach ramp with moderate speed.'],
      ['Kicker 360', 'kicker', 'advanced', 'Full rotation off a kicker.', 'Approach with enough speed.'],
      ['Kicker Grab', 'kicker', 'intermediate', 'Add a grab to your kicker air.', 'Get comfortable with basic airs first.'],
      ['Method Air', 'kicker', 'advanced', 'Stylish tweaked grab off kicker.', 'Pop off kicker, reach behind.'],
      ['Kicker to Fakie', 'kicker', 'intermediate', 'Land switch off the kicker.', 'Approach kicker regular.'],
      ['Shifty', 'kicker', 'intermediate', 'Twist board 90° in the air and back.', 'Pop off kicker and twist lower body.'],
      ['Rodeo', 'kicker', 'advanced', 'Off-axis flip rotation.', 'Combine backflip with 180 spin.'],
      ['50-50 Grind', 'rail', 'beginner', 'Ride straight across the rail.', 'Pop onto rail and center weight.'],
      ['Frontside Boardslide', 'rail', 'intermediate', 'Slide perpendicular with front facing uphill.', 'Approach at angle.'],
      ['Backside Boardslide', 'rail', 'intermediate', 'Slide perpendicular with back facing uphill.', 'Approach from opposite angle.'],
      ['Frontside Lipslide', 'rail', 'advanced', 'Pop over the rail into frontside slide.', 'Approach with rail on heelside.'],
      ['Gap to Rail', 'rail', 'advanced', 'Ollie gap onto a rail feature.', 'Approach gap with speed.'],
      ['Nose Press Rail', 'rail', 'intermediate', 'Press the nose while sliding.', 'Get on rail in 50-50.'],
      ['Tail Press Rail', 'rail', 'intermediate', 'Press the tail while sliding.', 'On rail, shift weight to back foot.'],
      ['270 On', 'rail', 'advanced', 'Spin 270° onto the rail.', 'Approach rail, pop and spin 270.'],
      ['270 Off', 'rail', 'advanced', 'Spin 270° off the rail to land.', 'While in 50-50, pop off end.']
    ];

    const existingTricks = await db.query('SELECT name FROM tricks');
    const existingNames = existingTricks.rows.map(t => t.name);
    results.steps.push(`  Found ${existingNames.length} existing tricks`);

    let addedCount = 0;
    for (const trick of allTricks) {
      const [name, category, difficulty, description, fullDescription] = trick;
      if (!existingNames.includes(name)) {
        try {
          await db.query(
            `INSERT INTO tricks (name, category, difficulty, description, full_description) VALUES ($1, $2, $3, $4, $5)`,
            [name, category, difficulty, description, fullDescription]
          );
          addedCount++;
        } catch (err) {
          results.errors.push(`Error adding trick ${name}: ${err.message}`);
        }
      }
    }
    results.steps.push(`  ✅ Added ${addedCount} new tricks`);

    // STEP 3: Generate public_id for all records
    results.steps.push('Step 3: Generating public_id for all records...');

    for (const table of tables) {
      try {
        const recordsWithoutId = await db.query(
          `SELECT id FROM ${table.name} WHERE public_id IS NULL ORDER BY id`
        );

        if (recordsWithoutId.rows.length > 0) {
          for (const record of recordsWithoutId.rows) {
            const newPublicId = await generatePublicId(table.name, table.prefix);
            await db.query(
              `UPDATE ${table.name} SET public_id = $1 WHERE id = $2`,
              [newPublicId, record.id]
            );
          }
          results.steps.push(`  ✅ Generated ${recordsWithoutId.rows.length} public_ids for ${table.name}`);
        } else {
          results.steps.push(`  ⏭️ All records in ${table.name} already have public_id`);
        }
      } catch (err) {
        results.errors.push(`Error generating IDs for ${table.name}: ${err.message}`);
      }
    }

    // Summary
    for (const table of tables) {
      try {
        const total = await db.query(`SELECT COUNT(*) as count FROM ${table.name}`);
        const withId = await db.query(`SELECT COUNT(*) as count FROM ${table.name} WHERE public_id IS NOT NULL`);
        results.summary[table.name] = {
          total: parseInt(total.rows[0].count),
          withPublicId: parseInt(withId.rows[0].count)
        };
      } catch (err) {
        results.summary[table.name] = { error: err.message };
      }
    }

    results.success = true;
    results.message = '✅ Migration completed! You can now remove /api/run-migration endpoint from server.js';

  } catch (error) {
    results.success = false;
    results.message = '❌ Migration failed: ' + error.message;
    results.errors.push(error.message);
  }

  res.json(results);
});

// ==================== START SERVER ====================
const startServer = async () => {
  try {
    await db.initDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 WakeWay API running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
