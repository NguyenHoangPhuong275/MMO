const { MongoClient } = require('mongodb');
const dns = require('dns');

// Configure public DNS servers for reliable SRV resolution on Windows
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  // Ignore if DNS server configuration is restricted
}

class MongoService {
  constructor() {
    this.client = null;
    this.db = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.uri = process.env.MONGODB_URI || 'mongodb+srv://thanhlong98371_db_user:u1HE4GDnXdGKEk43@cluster0.nb9hogw.mongodb.net/shop_mmo?retryWrites=true&w=majority&appName=Cluster0';
    this.dbName = process.env.MONGODB_DB_NAME || 'shop_mmo';
  }

  async connect() {
    if (this.isConnected) return this.db;
    if (this.isConnecting) return null;

    this.isConnecting = true;
    try {
      this.client = new MongoClient(this.uri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      });

      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.isConnected = true;
      this.isConnecting = false;
      console.log(`[MongoDB] Connected successfully to MongoDB Atlas database: ${this.dbName}`);

      // Create indexes for optimal query speed
      await this.initIndexes();
      return this.db;
    } catch (err) {
      this.isConnecting = false;
      this.isConnected = false;
      console.warn(`[MongoDB] Atlas connection warning: ${err.message}. Local SQLite fallback active.`);
      return null;
    }
  }

  async initIndexes() {
    if (!this.isConnected || !this.db) return;
    try {
      await this.db.collection('users').createIndex({ username: 1 }, { unique: true, sparse: true });
      await this.db.collection('users').createIndex({ sqlite_id: 1 });
      await this.db.collection('orders').createIndex({ upstream_order_id: 1 });
      await this.db.collection('orders').createIndex({ sqlite_id: 1 });
      await this.db.collection('direct_checkouts').createIndex({ code: 1 }, { unique: true, sparse: true });
      await this.db.collection('direct_checkouts').createIndex({ idempotency_key: 1 });
      await this.db.collection('transactions').createIndex({ sqlite_id: 1 });
    } catch (err) {
      console.warn('[MongoDB] Index creation warning:', err.message);
    }
  }

  // Sync a user document
  async syncUser(user) {
    if (!this.isConnected || !this.db || !user || !user.username) return;
    try {
      const cleanUsername = String(user.username).trim();
      await this.db.collection('users').updateOne(
        { username: cleanUsername },
        { 
          $set: { 
            sqlite_id: Number(user.id) || null,
            username: cleanUsername,
            email: user.email ? String(user.email).trim() : null,
            password_hash: String(user.password_hash || ''),
            balance_vnd: Number(user.balance_vnd) || 0,
            balance_usdt: Number(user.balance_usdt) || 0,
            role: String(user.role || 'customer'),
            updated_at: new Date()
          },
          $setOnInsert: {
            created_at: user.created_at ? new Date(user.created_at) : new Date()
          }
        },
        { upsert: true }
      );
    } catch (err) {
      console.warn('[MongoDB] syncUser warning:', err.message);
    }
  }

  // Sync an order document
  async syncOrder(order) {
    if (!this.isConnected || !this.db || !order || !order.id) return;
    try {
      const sqliteId = Number(order.id);
      await this.db.collection('orders').updateOne(
        { sqlite_id: sqliteId },
        {
          $set: {
            sqlite_id: sqliteId,
            user_id: Number(order.user_id),
            upstream_order_id: order.upstream_order_id ? Number(order.upstream_order_id) : null,
            product_id: Number(order.product_id),
            product_name: String(order.product_name || ''),
            quantity: Number(order.quantity) || 1,
            currency: String(order.currency || 'vnd'),
            price_paid: Number(order.price_paid) || 0,
            cost_price: Number(order.cost_price) || 0,
            profit: Number(order.profit) || 0,
            items: Array.isArray(order.items) ? order.items : (typeof order.items === 'string' ? JSON.parse(order.items || '[]') : []),
            status: String(order.status || 'completed'),
            updated_at: new Date()
          },
          $setOnInsert: {
            created_at: order.created_at ? new Date(order.created_at) : new Date()
          }
        },
        { upsert: true }
      );
    } catch (err) {
      console.warn('[MongoDB] syncOrder warning:', err.message);
    }
  }

  // Sync a direct checkout document
  async syncDirectCheckout(checkout) {
    if (!this.isConnected || !this.db || !checkout || !checkout.code) return;
    try {
      const cleanCode = String(checkout.code).trim().toUpperCase();
      await this.db.collection('direct_checkouts').updateOne(
        { code: cleanCode },
        {
          $set: {
            sqlite_id: Number(checkout.id) || null,
            code: cleanCode,
            idempotency_key: String(checkout.idempotency_key || ''),
            user_id: Number(checkout.user_id),
            product_id: Number(checkout.product_id),
            product_name: String(checkout.product_name || ''),
            quantity: Number(checkout.quantity) || 1,
            amount_vnd: Number(checkout.amount_vnd) || 0,
            cost_price_vnd: Number(checkout.cost_price_vnd) || 0,
            qr_url: String(checkout.qr_url || ''),
            payment_provider: String(checkout.payment_provider || 'payos'),
            payment_transaction_id: checkout.payment_transaction_id ? String(checkout.payment_transaction_id) : null,
            status: String(checkout.status || 'pending'),
            error: checkout.error ? String(checkout.error) : null,
            order_id: checkout.order_id ? Number(checkout.order_id) : null,
            expires_at: checkout.expires_at ? new Date(checkout.expires_at) : null,
            paid_at: checkout.paid_at ? new Date(checkout.paid_at) : null,
            delivered_at: checkout.delivered_at ? new Date(checkout.delivered_at) : null,
            updated_at: new Date()
          },
          $setOnInsert: {
            created_at: checkout.created_at ? new Date(checkout.created_at) : new Date()
          }
        },
        { upsert: true }
      );
    } catch (err) {
      console.warn('[MongoDB] syncDirectCheckout warning:', err.message);
    }
  }

  // Replicate all existing data from SQLite to MongoDB Atlas
  async syncAllFromSqlite(sqliteDb) {
    if (!this.isConnected || !this.db) {
      await this.connect();
    }
    if (!this.isConnected || !this.db) return { success: false, error: 'Cannot connect to MongoDB Atlas' };

    try {
      const users = sqliteDb.prepare('SELECT * FROM users').all();
      const orders = sqliteDb.prepare('SELECT * FROM orders').all();
      const checkouts = sqliteDb.prepare('SELECT * FROM direct_checkouts').all();
      const transactions = sqliteDb.prepare('SELECT * FROM transactions').all();

      for (const u of users) {
        await this.syncUser(u);
      }
      for (const o of orders) {
        await this.syncOrder(o);
      }
      for (const c of checkouts) {
        await this.syncDirectCheckout(c);
      }
      for (const t of transactions) {
        await this.db.collection('transactions').updateOne(
          { sqlite_id: t.id },
          { $set: { ...t, updated_at: new Date() } },
          { upsert: true }
        );
      }

      console.log(`[MongoDB] Replication complete: ${users.length} users, ${orders.length} orders, ${checkouts.length} checkouts, ${transactions.length} transactions synced to Atlas.`);
      return {
        success: true,
        counts: {
          users: users.length,
          orders: orders.length,
          checkouts: checkouts.length,
          transactions: transactions.length
        }
      };
    } catch (err) {
      console.error('[MongoDB] syncAllFromSqlite error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.isConnected = false;
    }
  }
}

module.exports = new MongoService();
