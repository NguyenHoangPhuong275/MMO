require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const db = require('./database');
const msbPaymentReconciler = require('./services/msbPaymentReconciler');
const payosService = require('./services/payosService');
const mongoService = require('./services/mongoService');

const {
  prototypePollutionShield,
  createSecurityHeaders,
  safeErrorHandler
} = require('./middleware/security');

const createAuthRoutes = require('./routes/authRoutes');
const createShopRoutes = require('./routes/shopRoutes');
const createAdminRoutes = require('./routes/adminRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
let JWT_SECRET = process.env.JWT_SECRET || db.getSetting('jwt_secret');
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS) || 0;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);

// Rotate insecure fallback secret automatically
if (!process.env.JWT_SECRET && (!JWT_SECRET || JWT_SECRET === 'mmo_super_secure_jwt_secret_key_2026_x789')) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  db.setSetting('jwt_secret', JWT_SECRET);
  console.warn('⚠️ Generated dynamic secure JWT secret for this installation.');
}

// Reverse Proxy Trust Configuration
if (TRUST_PROXY_HOPS > 0) {
  app.set('trust proxy', TRUST_PROXY_HOPS);
}

// Global Middlewares & Security Hardening
app.disable('x-powered-by');

// Request Tracing ID
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});

// Helmet Security Headers & Content Security Policy (CSP)
app.use(createSecurityHeaders());

// Prototype Pollution Defense Middleware
app.use(prototypePollutionShield);

// HTTP Compression
app.use(compression());

// CORS Whitelist Configuration
if (allowedOrigins.length > 0) {
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin không được phép'));
    }
  }));
}

// Request Body Limits
app.use(express.json({ limit: '32kb' }));

// Static Assets with Caching & ETag
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
  }
}));

// Rate Limiters
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Quá nhiều yêu cầu, vui lòng thử lại sau giây lát.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { success: false, error: 'Bạn đã thử đăng nhập/đăng ký quá nhiều lần. Vui lòng thử lại sau 15 phút.' }
});

const purchaseLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 40,
  message: { success: false, error: 'Thao tác mua quá nhanh. Vui lòng chờ vài giây.' }
});

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Bạn đã tạo quá nhiều đơn thanh toán. Vui lòng thử lại sau.' }
});

app.use('/api/', generalLimiter);

// JWT Authentication Middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = db.getUserById(decoded.userId);
    req.user = user || null;
  } catch (err) {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Vui lòng đăng nhập để thực hiện chức năng này.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Quyền truy cập bị từ chối. Chỉ dành cho Quản trị viên.' });
  }
  next();
}

app.use(authMiddleware);

// ==========================================
// MOUNT MODULAR API ROUTES
// ==========================================
const authRouter = createAuthRoutes({ JWT_SECRET, authLimiter, requireAuth });
app.use('/api/auth', authRouter);

const shopModule = createShopRoutes({ requireAuth, purchaseLimiter, checkoutLimiter });
app.use('/api/shop', shopModule.router);

const adminRouter = createAdminRoutes({
  requireAdmin,
  deliverPayosPaidCheckout: shopModule.deliverPayosPaidCheckout
});
app.use('/api/admin', adminRouter);

// ==========================================
// PAYOS WEBHOOK ENDPOINT
// ==========================================
app.post(['/api/payments/payos/webhook', '/api/payment/payos/webhook'], async (req, res) => {
  try {
    const webhookData = await payosService.verifyWebhookData(req.body);
    console.log(`✅ [PayOS Webhook] Verified webhook for orderCode: ${webhookData.orderCode}`);

    if (webhookData && (webhookData.code === '00' || req.body.code === '00' || webhookData.desc === 'success')) {
      const { orderCode, amount, reference, description } = webhookData;

      const claim = db.claimPayosPaymentEvent({
        orderCode: Number(orderCode),
        transactionId: reference || `PAYOS_${orderCode}_${Date.now()}`,
        amountVnd: Number(amount),
        description: description || `PayOS Order ${orderCode}`,
        rawPayload: req.body
      });

      if (claim.status === 'claimed' && claim.checkout) {
        await shopModule.deliverPayosPaidCheckout(claim.checkout);
      }
    }

    return res.json({ success: true, message: 'Webhook processed' });
  } catch (err) {
    console.error('PayOS Webhook error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ==========================================
// SPA & HEALTH MONITOR
// ==========================================
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    service: 'shop-bot-mmo',
    uptime: Math.floor(process.uptime()),
    mongodb_connected: mongoService.isConnected
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint không tồn tại' });
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized Safe Error Handler
app.use(safeErrorHandler);

// ==========================================
// START SERVER & LIFECYCLE
// ==========================================
const server = app.listen(PORT, () => {
  msbPaymentReconciler.start();
  console.log(`====================================================`);
  console.log(`🚀 SHOP BOT MMO STOREFRONT RUNNING ON http://localhost:${PORT}`);
  console.log(`⚡ ARCHITECTURE: SQLite WAL + Cache Shield + Rate Limiting + Idempotency`);
  console.log(`🛡️ SECURITY: CSP + Helmet + Prototype Shield + Timing Attack Defense`);
  if (!process.env.ADMIN_PASSWORD) console.warn('⚠️ Set ADMIN_PASSWORD in production and rotate any legacy admin credential.');
  console.log(`====================================================`);

  // Initialize MongoDB Atlas connection & replication
  mongoService.connect().then(async (mDb) => {
    if (mDb) {
      await mongoService.syncAllFromSqlite(db.db);
    }
  }).catch(e => console.warn('[MongoDB] Startup sync warning:', e.message));
});

function shutdown(signal) {
  console.log(`${signal} received, closing server...`);
  server.close(async () => {
    await msbPaymentReconciler.stop();
    await mongoService.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
