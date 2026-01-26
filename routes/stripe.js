// Stripe Routes - /api/stripe/*
const express = require('express');
const router = express.Router();
const config = require('../config');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { generatePublicId } = require('../utils/publicId');

const stripe = require('stripe')(config.STRIPE_SECRET_KEY);

// Get Stripe publishable key
router.get('/config', (req, res) => {
  res.json({ publishableKey: config.STRIPE_PUBLISHABLE_KEY });
});

// Create Stripe Checkout Session
router.post('/create-checkout-session', authMiddleware, async (req, res) => {
  try {
    const { product_id, booking_date, booking_time, phone, shipping_address } = req.body;
    
    // Get product
    const productResult = await db.query('SELECT * FROM products WHERE id = $1', [product_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const product = productResult.rows[0];
    const isClothes = product.category === 'clothes';
    
    // Validation
    if (!isClothes && !booking_date) {
      return res.status(400).json({ error: 'Booking date is required for this product' });
    }
    if (isClothes && !shipping_address) {
      return res.status(400).json({ error: 'Shipping address is required for clothes' });
    }

    // Create order in pending state
    const publicId = await generatePublicId('orders', 'ORD');
    
    const orderResult = await db.query(`
      INSERT INTO orders (
        public_id, user_id, product_id, product_name, product_category, 
        amount, booking_date, booking_time, phone, shipping_address, 
        status, fake, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, NOW())
      RETURNING *
    `, [
      publicId, 
      req.user.id, 
      product.id, 
      product.name, 
      product.category,
      product.price,
      isClothes ? null : booking_date,
      isClothes ? null : (booking_time || null),
      phone || null,
      isClothes ? shipping_address : null,
      'pending_payment'
    ]);
    
    const order = orderResult.rows[0];

    // Create Stripe Checkout Session
    const baseUrl = req.headers.origin || config.APP_URL;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: product.name,
            description: isClothes 
              ? `Shipping to: ${shipping_address}` 
              : `Booking: ${booking_date} at ${booking_time || 'Any time'}`,
          },
          unit_amount: Math.round(product.price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/?payment=success&order=${publicId}`,
      cancel_url: `${baseUrl}/?payment=cancelled&order=${publicId}`,
      customer_email: req.user.email,
      metadata: {
        order_id: order.id,
        order_public_id: publicId,
        user_id: req.user.id,
      },
    });

    // Update order with Stripe session ID
    await db.query(
      'UPDATE orders SET stripe_session_id = $1 WHERE id = $2',
      [session.id, order.id]
    );

    res.json({ 
      sessionId: session.id, 
      sessionUrl: session.url,
      orderId: publicId 
    });
  } catch (error) {
    console.error('Create checkout session error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

module.exports = router;
