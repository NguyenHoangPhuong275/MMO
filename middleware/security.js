const crypto = require('crypto');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');

// Pre-computed dummy hash for constant-time password comparison (mitigating timing attacks)
const DUMMY_HASH = bcrypt.hashSync('dummy_timing_attack_mitigation_password_2026', 10);

/**
 * Prototype Pollution Shield: Recursively strips keys like __proto__, constructor, prototype
 */
function sanitizeObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return obj;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = sanitizeObject(obj[i], depth + 1);
    }
    return obj;
  }

  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
  for (const key of Object.keys(obj)) {
    if (dangerousKeys.includes(key.toLowerCase()) || key.startsWith('$')) {
      delete obj[key];
      continue;
    }
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      obj[key] = sanitizeObject(obj[key], depth + 1);
    }
  }
  return obj;
}

function prototypePollutionShield(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    sanitizeObject(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    sanitizeObject(req.params);
  }
  next();
}

/**
 * Safe String/Scalar Extractor: Chống Parameter Pollution (e.g. ?code=A&code=B)
 */
function safeString(val, maxLength = 255) {
  if (val === undefined || val === null) return '';
  if (Array.isArray(val)) val = val[0];
  return String(val).trim().slice(0, maxLength);
}

function safeInt(val, fallback = 0, min = -Infinity, max = Infinity) {
  if (val === undefined || val === null) return fallback;
  if (Array.isArray(val)) val = val[0];
  const num = parseInt(val, 10);
  if (Number.isNaN(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

function safeFloat(val, fallback = 0, min = -Infinity, max = Infinity) {
  if (val === undefined || val === null) return fallback;
  if (Array.isArray(val)) val = val[0];
  const num = parseFloat(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

/**
 * Constant-time password verification helper
 */
function secureVerifyPassword(user, candidatePassword) {
  if (!user || !user.password_hash) {
    // Perform dummy comparison so timing matches a real check
    bcrypt.compareSync(candidatePassword || '', DUMMY_HASH);
    return false;
  }
  return bcrypt.compareSync(candidatePassword || '', user.password_hash);
}

/**
 * Helmet Security Headers Configuration with tailored Content Security Policy
 */
function createSecurityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https://img.vietqr.io", "https://api.vietqr.io", "https://*.payos.vn"],
        connectSrc: ["'self'", "https://api.vietqr.io", "https://api-merchant.payos.vn", "https://tunvnmmo.duckdns.org"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'same-origin' },
    xssFilter: true,
    noSniff: true,
    frameguard: { action: 'deny' },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });
}

/**
 * Safe Error Handler: Masks database syntax and internal stack traces in production
 */
function safeErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const isProduction = process.env.NODE_ENV === 'production';
  const requestId = req.requestId || crypto.randomUUID();

  // Log full error internally with context
  console.error(`[SecurityError][${requestId}] Path: ${req.method} ${req.originalUrl} -`, err.stack || err.message);

  let statusCode = 500;
  let clientMessage = 'Máy chủ không thể xử lý yêu cầu lúc này. Vui lòng thử lại sau.';

  if (err.message === 'Origin không được phép') {
    statusCode = 403;
    clientMessage = 'Origin không được phép truy cập API này.';
  } else if (err.type === 'entity.too.large') {
    statusCode = 413;
    clientMessage = 'Kích thước dữ liệu gửi lên vượt quá giới hạn cho phép.';
  } else if (err.status && err.status < 500) {
    statusCode = err.status;
    clientMessage = err.message;
  }

  res.status(statusCode).json({
    success: false,
    error: clientMessage,
    request_id: requestId,
    ...(isProduction ? {} : { debug_info: err.message })
  });
}

module.exports = {
  prototypePollutionShield,
  sanitizeObject,
  safeString,
  safeInt,
  safeFloat,
  secureVerifyPassword,
  createSecurityHeaders,
  safeErrorHandler
};
