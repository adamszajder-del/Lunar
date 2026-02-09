// Routes Aggregator
const express = require('express');
const router = express.Router();
const { createRateLimiter } = require('../middleware/rateLimit');

// Import all route modules
const authRoutes = require('./auth');
const usersRoutes = require('./users');
const tricksRoutes = require('./tricks');
const eventsRoutes = require('./events');
const newsRoutes = require('./news');
const articlesRoutes = require('./articles');
const productsRoutes = require('./products');
const cartRoutes = require('./cart');
const ordersRoutes = require('./orders');
const stripeRoutes = require('./stripe');
const rfidRoutes = require('./rfid');
const achievementsRoutes = require('./achievements');
const feedRoutes = require('./feed');
const healthRoutes = require('./health');
const adminRoutes = require('./admin');
const migrationsRoutes = require('./migrations');

// Rate limiters for public/sensitive endpoints
const authRateLimiter = createRateLimiter({ prefix: 'auth', maxRequests: 10, windowMs: 60000 }); // 10/min
const rfidRateLimiter = createRateLimiter({ prefix: 'rfid', maxRequests: 30, windowMs: 60000 }); // 30/min
const verifyRateLimiter = createRateLimiter({ prefix: 'verify', maxRequests: 15, windowMs: 60000 }); // 15/min
const migrationRateLimiter = createRateLimiter({ prefix: 'migrate', maxRequests: 5, windowMs: 60000 }); // 5/min

// Mount routes
router.use('/auth', authRateLimiter, authRoutes);
router.use('/users', usersRoutes);
router.use('/tricks', tricksRoutes);
router.use('/events', eventsRoutes);
router.use('/news', newsRoutes);
router.use('/articles', articlesRoutes);
router.use('/products', productsRoutes);
router.use('/cart', cartRoutes);
router.use('/orders', ordersRoutes);
router.use('/stripe', stripeRoutes);
router.use('/rfid', rfidRateLimiter, rfidRoutes);
router.use('/achievements', achievementsRoutes);
router.use('/feed', feedRoutes);
router.use('/', verifyRateLimiter, healthRoutes); // /api/health, /api/verify/:code
router.use('/admin', adminRoutes);
router.use('/', migrationRateLimiter, migrationsRoutes); // /api/run-*-migration

module.exports = router;
