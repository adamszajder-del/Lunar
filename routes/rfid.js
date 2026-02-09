// RFID Routes - /api/rfid/*
const express = require('express');
const router = express.Router();
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// Assign RFID band to user
router.post('/assign', authMiddleware, async (req, res) => {
  try {
    const { band_uid, user_id } = req.body;
    const targetUserId = user_id || req.user.id;

    // Only admin can assign to other users
    if (user_id && user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Check if band already assigned
    const existing = await db.query(
      'SELECT * FROM rfid_bands WHERE band_uid = $1',
      [band_uid]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Band already assigned to a user' });
    }

    await db.query(
      'INSERT INTO rfid_bands (band_uid, user_id) VALUES ($1, $2)',
      [band_uid, targetUserId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Assign RFID error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Scan RFID band (public)
router.get('/scan/:band_uid', async (req, res) => {
  try {
    const { band_uid } = req.params;

    const result = await db.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_base64, u.public_id,
             u.is_coach, u.is_staff, u.is_club_member
      FROM rfid_bands rb
      JOIN users u ON rb.user_id = u.id
      WHERE rb.band_uid = $1
    `, [band_uid]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Band not found or not assigned' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Scan RFID error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unassign RFID band
router.delete('/unassign/:band_uid', authMiddleware, async (req, res) => {
  try {
    const { band_uid } = req.params;

    // Check ownership
    const band = await db.query(
      'SELECT user_id FROM rfid_bands WHERE band_uid = $1',
      [band_uid]
    );

    if (band.rows.length === 0) {
      return res.status(404).json({ error: 'Band not found' });
    }

    if (band.rows[0].user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await db.query('DELETE FROM rfid_bands WHERE band_uid = $1', [band_uid]);
    res.json({ success: true });
  } catch (error) {
    console.error('Unassign RFID error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get my bands
router.get('/my-bands', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM rfid_bands WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get my bands error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
