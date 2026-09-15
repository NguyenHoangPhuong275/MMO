const db = require('../database');
const upstreamService = require('./upstreamService');

const TERMINAL_FAILURE_STATUSES = new Set(['expired', 'cancelled', 'canceled', 'failed']);

class DepositReconciler {
  constructor() {
    this.timer = null;
    this.isRunning = false;
  }

  async reconcileDeposit(deposit) {
    const statusData = await upstreamService.checkDepositStatus(deposit.code);
    const upstreamStatus = String(statusData?.deposit?.status || '').toLowerCase();
    const isPaid = statusData?.paid === true || upstreamStatus === 'confirmed';

    if (isPaid) {
      return db.completeUsdtDeposit(deposit.user_id, deposit.code, statusData.deposit?.amount);
    }

    if (TERMINAL_FAILURE_STATUSES.has(upstreamStatus)) {
      db.failUsdtDeposit(deposit.user_id, deposit.code, `Nhà cung cấp báo trạng thái ${upstreamStatus}`);
    }

    return { credited: false };
  }

  async pollOnce() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      db.expireStaleUsdtDeposits(1440);
      const pendingDeposits = db.getPendingUsdtDeposits(50);
      const batches = [];
      for (let index = 0; index < pendingDeposits.length; index += 5) {
        batches.push(pendingDeposits.slice(index, index + 5));
      }

      for (const batch of batches) {
        await Promise.allSettled(batch.map(deposit => this.reconcileDeposit(deposit)));
      }
    } finally {
      this.isRunning = false;
    }
  }

  start(intervalMs = 20000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch(error => console.warn('USDT deposit reconciliation failed:', error.message));
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = new DepositReconciler();
