// Admin Routes - /api/admin/*
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { authMiddleware, adminMiddleware } = require('../../middleware/auth');
const { generatePublicId } = require('../../utils/publicId');
const { sendEmail, templates } = require('../../utils/email');

// Middleware: all admin routes require admin
router.use(authMiddleware);
router.use(adminMiddleware);

// ==================== USERS ====================

// Get all users
router.get('/users', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, email, username, display_name, avatar_base64,
             is_admin, is_coach, is_staff, is_club_member, is_approved, is_blocked,
             created_at, last_login
      FROM users ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get pending users
router.get('/pending-users', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, email, username, created_at
      FROM users WHERE is_approved = false
      ORDER BY created_at ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get pending users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve user
router.post('/approve-user/:userId', async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE users SET is_approved = true WHERE id = $1 RETURNING email, username',
      [req.params.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Send approval email
    const user = result.rows[0];
    sendEmail(user.email, templates.accountApproved(user.username));
    
    res.json({ success: true, message: 'User approved' });
  } catch (error) {
    console.error('Approve user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reject user
router.delete('/reject-user/:userId', async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id = $1 AND is_approved = false', [req.params.userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Reject user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Block user
router.post('/users/:id/block', async (req, res) => {
  try {
    await db.query('UPDATE users SET is_blocked = true WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Unblock user
router.post('/users/:id/unblock', async (req, res) => {
  try {
    await db.query('UPDATE users SET is_blocked = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user roles
router.patch('/users/:id/roles', async (req, res) => {
  try {
    const { is_coach, is_staff, is_club_member } = req.body;
    await db.query(`
      UPDATE users 
      SET is_coach = COALESCE($1, is_coach),
          is_staff = COALESCE($2, is_staff),
          is_club_member = COALESCE($3, is_club_member)
      WHERE id = $4
    `, [is_coach, is_staff, is_club_member, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== TRICKS ====================

router.post('/tricks', async (req, res) => {
  try {
    const { name, category, difficulty, description, full_description, video_url } = req.body;
    const publicId = await generatePublicId('tricks', 'TRICK');
    const result = await db.query(
      `INSERT INTO tricks (public_id, name, category, difficulty, description, full_description, video_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [publicId, name, category, difficulty, description || '', full_description || '', video_url || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/tricks/:id', async (req, res) => {
  try {
    const { name, category, difficulty, description, full_description, video_url } = req.body;
    const result = await db.query(
      `UPDATE tricks SET name = $1, category = $2, difficulty = $3, description = $4, full_description = $5, video_url = $6
       WHERE id = $7 RETURNING *`,
      [name, category, difficulty, description, full_description, video_url, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/tricks/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM tricks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== EVENTS ====================

router.get('/events', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.*, u.username as author_username,
             (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendees
      FROM events e LEFT JOIN users u ON e.author_id = u.id
      ORDER BY e.date DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/events', async (req, res) => {
  try {
    const { name, date, time, location, location_url, spots } = req.body;
    const publicId = await generatePublicId('events', 'EVENT');
    const result = await db.query(
      `INSERT INTO events (public_id, name, date, time, location, location_url, spots, author_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [publicId, name, date, time, location, location_url || null, spots || 10, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/events/:id', async (req, res) => {
  try {
    const { name, date, time, location, location_url, spots } = req.body;
    const result = await db.query(
      `UPDATE events SET name = $1, date = $2, time = $3, location = $4, location_url = $5, spots = $6
       WHERE id = $7 RETURNING *`,
      [name, date, time, location, location_url, spots, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/events/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== NEWS ====================

router.get('/news', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM news ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/news', async (req, res) => {
  try {
    const { title, message, type, emoji, event_details } = req.body;
    const publicId = await generatePublicId('news', 'NEWS');
    const result = await db.query(
      `INSERT INTO news (public_id, title, message, type, emoji, event_details) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [publicId, title, message, type || 'info', emoji || '📢', event_details || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/news/:id', async (req, res) => {
  try {
    const { title, message, type, emoji, event_details } = req.body;
    const result = await db.query(
      `UPDATE news SET title = $1, message = $2, type = $3, emoji = $4, event_details = $5
       WHERE id = $6 RETURNING *`,
      [title, message, type, emoji, event_details, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/news/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM news WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ARTICLES ====================

router.post('/articles', async (req, res) => {
  try {
    const { category, title, description, content, read_time } = req.body;
    const publicId = await generatePublicId('articles', 'ART');
    const result = await db.query(
      `INSERT INTO articles (public_id, category, title, description, content, read_time, author_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [publicId, category, title, description || '', content || '', read_time || '5 min', req.user.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/articles/:id', async (req, res) => {
  try {
    const { category, title, description, content, read_time } = req.body;
    const result = await db.query(
      `UPDATE articles SET category = $1, title = $2, description = $3, content = $4, read_time = $5
       WHERE id = $6 RETURNING *`,
      [category, title, description, content, read_time, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/articles/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM articles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== PRODUCTS ====================

router.get('/products', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM products ORDER BY category, name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/products', async (req, res) => {
  try {
    const { name, description, price, category, image_url, stripe_price_id, is_active } = req.body;
    const publicId = await generatePublicId('products', 'PROD');
    const result = await db.query(
      `INSERT INTO products (public_id, name, description, price, category, image_url, stripe_price_id, is_active) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [publicId, name, description || '', price, category, image_url || null, stripe_price_id || null, is_active !== false]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const { name, description, price, category, image_url, stripe_price_id, is_active } = req.body;
    const result = await db.query(
      `UPDATE products SET name = $1, description = $2, price = $3, category = $4, 
       image_url = $5, stripe_price_id = $6, is_active = $7
       WHERE id = $8 RETURNING *`,
      [name, description, price, category, image_url, stripe_price_id, is_active, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ORDERS ====================

router.get('/orders', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT o.*, u.username, u.email
      FROM orders o JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const result = await db.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== RFID ====================

router.get('/rfid/all', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT rb.*, u.username, u.email
      FROM rfid_bands rb LEFT JOIN users u ON rb.user_id = u.id
      ORDER BY rb.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/rfid/user/:userId', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM rfid_bands WHERE user_id = $1 ORDER BY created_at DESC',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/rfid/:bandId', async (req, res) => {
  try {
    await db.query('DELETE FROM rfid_bands WHERE id = $1', [req.params.bandId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== USER DETAILS ====================

// Get user's orders
router.get('/users/:id/orders', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, public_id, product_name, product_category, amount, 
             booking_date, booking_time, status, shipping_address, phone, created_at
      FROM orders 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's events
router.get('/users/:id/events', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.id, e.public_id, e.title, e.date, e.time, er.registered_at
      FROM event_registrations er
      JOIN events e ON er.event_id = e.id
      WHERE er.user_id = $1
      ORDER BY e.date DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get user events error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's login history
router.get('/users/:id/logins', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, email, login_time, ip_address, user_agent, success
      FROM user_logins
      WHERE user_id = $1
      ORDER BY login_time DESC
      LIMIT 50
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get user logins error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ACHIEVEMENTS ====================

// Get achievements statistics
router.get('/achievements/stats', async (req, res) => {
  try {
    const { ACHIEVEMENTS } = require('../achievements');
    
    let autoResult = { rows: [] };
    let manualResult = { rows: [] };
    
    try {
      autoResult = await db.query(`
        SELECT achievement_id, tier, COUNT(*) as count
        FROM user_achievements
        GROUP BY achievement_id, tier
        ORDER BY achievement_id, tier
      `);
    } catch (err) {
      console.log('user_achievements table may not exist:', err.message);
    }
    
    try {
      manualResult = await db.query(`
        SELECT achievement_id, COUNT(*) as count
        FROM user_manual_achievements
        GROUP BY achievement_id
      `);
    } catch (err) {
      console.log('user_manual_achievements table may not exist:', err.message);
    }
    
    const stats = {};
    
    for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
      stats[id] = {
        ...def,
        tiers: { bronze: 0, silver: 0, gold: 0, platinum: 0, special: 0 }
      };
    }
    
    autoResult.rows.forEach(row => {
      if (stats[row.achievement_id]) {
        stats[row.achievement_id].tiers[row.tier] = parseInt(row.count);
      }
    });
    
    manualResult.rows.forEach(row => {
      if (stats[row.achievement_id]) {
        stats[row.achievement_id].tiers.special = parseInt(row.count);
      }
    });
    
    res.json(Object.values(stats));
  } catch (error) {
    console.error('Get achievements stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's manual achievements
router.get('/users/:id/manual-achievements', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT uma.*, u.username as awarded_by_name
      FROM user_manual_achievements uma
      LEFT JOIN users u ON uma.awarded_by = u.id
      WHERE uma.user_id = $1
      ORDER BY uma.awarded_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get manual achievements error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/users/:id/grant-achievement', async (req, res) => {
  try {
    const { achievement_id, note } = req.body;
    await db.query(`
      INSERT INTO user_manual_achievements (user_id, achievement_id, awarded_by, note)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, achievement_id) DO NOTHING
    `, [req.params.id, achievement_id, req.user.id, note || null]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/users/:id/revoke-achievement/:achievementId', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_manual_achievements WHERE user_id = $1 AND achievement_id = $2',
      [req.params.id, req.params.achievementId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
