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
    if (!this.isConnected || !this.db || !user) return;
    try {
      await this.db.collection('users').updateOne(
        { username: user.username },
        { 
          $set: { 
            sqlite_id: user.id,
            username: user.username,
            email: user.email || null,
            password_hash: user.password_hash,
            balance_vnd: user.balance_vnd || 0,
            balance_usdt: user.balance_usdt || 0,
            role: user.role || 'customer',
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
    if (!this.isConnected || !this.db || !order) return;
    try {
      await this.db.collection('orders').updateOne(
        { sqlite_id: order.id },
        {
          $set: {
            sqlite_id: order.id,
            user_id: order.user_id,
            upstream_order_id: order.upstream_order_id || null,
            product_id: order.product_id,
            product_name: order.product_name,
            quantity: order.quantity,
            currency: order.currency || 'vnd',
            price_paid: order.price_paid,
            cost_price: order.cost_price,
            profit: order.profit,
            items: Array.isArray(order.items) ? order.items : (typeof order.items === 'string' ? JSON.parse(order.items || '[]') : []),
            status: order.status || 'completed',
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
    if (!this.isConnected || !this.db || !checkout) return;
    try {
      await this.db.collection('direct_checkouts').updateOne(
        { code: checkout.code },
        {
          $set: {
            sqlite_id: checkout.id,
            code: checkout.code,
            idempotency_key: checkout.idempotency_key,
            user_id: checkout.user_id,
            product_id: checkout.product_id,
            product_name: checkout.product_name,
            quantity: checkout.quantity,
            amount_vnd: checkout.amount_vnd,
            cost_price_vnd: checkout.cost_price_vnd,
            qr_url: checkout.qr_url,
            payment_provider: checkout.payment_provider || 'payos',
            payment_transaction_id: checkout.payment_transaction_id || null,
            status: checkout.status,
            error: checkout.error || null,
            order_id: checkout.order_id || null,
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
