// Events Routes - /api/events/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// Get all events
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.*, 
             u.username as creator_username,
             u.id as creator_id,
             u.avatar_base64 as creator_avatar,
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
router.get('/registered', authMiddleware, async (req, res) => {
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

// Register for event (with transaction to prevent overbooking)
router.post('/:id/register', authMiddleware, async (req, res) => {
  const client = await require('../database').getClient();
  try {
    const eventId = req.params.id;
    await client.query('BEGIN');

    // Lock the event row to prevent concurrent overbooking
    const event = await client.query(
      'SELECT spots FROM events WHERE id = $1 FOR UPDATE',
      [eventId]
    );

    if (event.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }

    // Check if already registered
    const existing = await client.query(
      'SELECT id FROM event_attendees WHERE event_id = $1 AND user_id = $2',
      [eventId, req.user.id]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already registered' });
    }

    // Check spots
    const attendees = await client.query(
      'SELECT COUNT(*) as count FROM event_attendees WHERE event_id = $1',
      [eventId]
    );

    if (parseInt(attendees.rows[0].count) >= event.rows[0].spots) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Event is full' });
    }

    await client.query(
      'INSERT INTO event_attendees (event_id, user_id) VALUES ($1, $2)',
      [eventId, req.user.id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Register event error:', error);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Unregister from event
router.delete('/:id/register', authMiddleware, async (req, res) => {
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

// Get event participants
router.get('/:id/participants', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_base64
      FROM event_attendees ea
      JOIN users u ON ea.user_id = u.id
      WHERE ea.event_id = $1
      ORDER BY ea.registered_at
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get event participants error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
