const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { secureVerifyPassword, safeString } = require('../middleware/security');

function createAuthRoutes({ JWT_SECRET, authLimiter, requireAuth }) {
  const router = express.Router();

  // POST /api/auth/register
  router.post('/register', authLimiter, (req, res, next) => {
    try {
      const username = safeString(req.body.username, 40);
      const email = safeString(req.body.email, 120);
      const password = typeof req.body.password === 'string' ? req.body.password : '';

      if (!username || username.length < 3) {
        return res.status(400).json({ success: false, error: 'Tên tài khoản phải từ 3 ký tự trở lên.' });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ success: false, error: 'Mật khẩu phải từ 6 ký tự trở lên.' });
      }

      // Check existing username (case-insensitive)
      const existing = db.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ success: false, error: 'Tên tài khoản này đã được sử dụng.' });
      }

      const user = db.createUser(username, email || null, password);
      const token = jwt.sign(
        { userId: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '30d' }
      );

      return res.status(200).json({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/login
  router.post('/login', authLimiter, (req, res, next) => {
    try {
      const username = safeString(req.body.username, 40);
      const password = typeof req.body.password === 'string' ? req.body.password : '';

      if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Vui lòng nhập tên tài khoản và mật khẩu.' });
      }

      const user = db.getUserByUsername(username);
      // Constant-time password verification to prevent timing attack enumeration
      const isValid = secureVerifyPassword(user, password);

      if (!user || !isValid) {
        return res.status(400).json({ success: false, error: 'Tên tài khoản hoặc mật khẩu không chính xác.' });
      }

      const token = jwt.sign(
        { userId: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '30d' }
      );

      return res.status(200).json({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/auth/me
  router.get('/me', requireAuth, (req, res) => {
    return res.json({
      success: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        email: req.user.email,
        role: req.user.role,
        created_at: req.user.created_at
      }
    });
  });

  return router;
}

module.exports = createAuthRoutes;
