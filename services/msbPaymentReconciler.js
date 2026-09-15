const db = require('../database');
const cacheService = require('./cacheService');
const upstreamService = require('./upstreamService');
const msbService = require('./msbService');

let timer = null;
let runningPromise = null;
let pollCount = 0;

async function deliverPaidCheckout(checkout) {
  try {
    const upstreamData = await upstreamService.buyProduct(checkout.product_id, checkout.quantity, 'vnd');
    db.completeMsbCheckout(
      checkout.id,
      upstreamData.items || [],
      upstreamData.order_id || null
    );
    cacheService.refreshProducts().catch(() => {});
  } catch (error) {
    db.markMsbCheckoutDeliveryFailed(checkout.id, error.message);
    console.error(`MSB checkout ${checkout.code} đã nhận tiền nhưng chưa giao được: ${error.message}`);
  }
}

async function reconcile({ allowLogin = false } = {}) {
  if (!msbService.isConfigured()) return;
  const events = await msbService.fetchRecentTransactions({ allowLogin });
  for (const event of events) {
    const result = db.claimMsbPaymentEvent(event);
    if (result.status === 'claimed') await deliverPaidCheckout(result.checkout);
  }
  db.expirePendingMsbCheckouts();
}

function checkNow(options = {}) {
  if (runningPromise) return runningPromise;
  runningPromise = reconcile(options)
    .catch(error => console.warn(`MSB reconcile error: ${error.name}`))
    .finally(() => { runningPromise = null; });
  return runningPromise;
}

function start() {
  if (timer || !msbService.isConfigured()) {
    if (!msbService.isConfigured()) console.warn('⚠️ Thanh toán MSB chưa bật: thiếu cấu hình trong .env');
    return;
  }
  const intervalSeconds = Math.min(Math.max(Number(process.env.MSB_POLL_INTERVAL) || 10, 7), 60);
  checkNow({ allowLogin: true });
  timer = setInterval(() => {
    pollCount += 1;
    checkNow({ allowLogin: pollCount % 30 === 0 });
  }, intervalSeconds * 1000);
  timer.unref();
}

async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (runningPromise) await runningPromise;
  await msbService.close();
}

module.exports = { start, stop, checkNow };
