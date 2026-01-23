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

    // Create user
    const result = await db.query(
      'INSERT INTO users (email, password_hash, username) VALUES ($1, $2, $3) RETURNING id, email, username',
      [email, passwordHash, username]
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
    const result = await db.query('SELECT id, email, username, is_admin FROM users WHERE id = $1', [decoded.userId]);
    
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

// ==================== USERS/CREW ROUTES ====================

// Get all crew members (public profiles)
app.get('/api/users/crew', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, username, display_name, avatar_url, is_coach, role,
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

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
