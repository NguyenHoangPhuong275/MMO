const { PayOS } = require('@payos/node');

class PayosService {
  constructor() {
    this.clientId = process.env.PAYOS_CLIENT_ID || '';
    this.apiKey = process.env.PAYOS_API_KEY || '';
    this.checksumKey = process.env.PAYOS_CHECKSUM_KEY || '';
    this.enabled = String(process.env.PAYOS_PAYMENT_ENABLED || 'true').toLowerCase() === 'true';

    if (this.clientId && this.apiKey && this.checksumKey) {
      try {
        this.payOS = new PayOS({
          clientId: this.clientId,
          apiKey: this.apiKey,
          checksumKey: this.checksumKey
        });
        console.log('✅ PayOS SDK v2 initialized successfully');
      } catch (err) {
        console.error('PayOS initialization error:', err.message);
        this.payOS = null;
      }
    } else {
      this.payOS = null;
    }
  }

  isConfigured() {
    return Boolean(this.enabled && this.payOS && this.clientId && this.apiKey && this.checksumKey);
  }

  /**
   * Tạo link thanh toán VietQR PayOS
   */
  async createPaymentLink({ orderCode, amount, description, items, returnUrl, cancelUrl }) {
    if (!this.isConfigured()) {
      throw new Error('Cổng thanh toán PayOS chưa được cấu hình');
    }

    // PayOS description: tối đa 25 ký tự, không dấu, không ký tự đặc biệt
    const sanitizedDescription = (description || `DH${orderCode}`)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim()
      .substring(0, 25);

    const body = {
      orderCode: Number(orderCode),
      amount: Math.round(Number(amount)),
      description: sanitizedDescription,
      items: items || [],
      returnUrl: returnUrl || 'http://localhost:3000',
      cancelUrl: cancelUrl || 'http://localhost:3000'
    };

    if (this.payOS.paymentRequests?.create) {
      return await this.payOS.paymentRequests.create(body);
    }
    if (typeof this.payOS.createPaymentLink === 'function') {
      return await this.payOS.createPaymentLink(body);
    }
    throw new Error('Phương thức tạo đơn PayOS không hợp lệ');
  }

  /**
   * Xác thực chữ ký webhook từ PayOS
   */
  async verifyWebhookData(webhookBody) {
    if (!this.isConfigured()) {
      throw new Error('Cổng thanh toán PayOS chưa được cấu hình');
    }

    if (this.payOS.webhooks?.verify) {
      return await this.payOS.webhooks.verify(webhookBody);
    }
    if (typeof this.payOS.verifyPaymentWebhookData === 'function') {
      return await this.payOS.verifyPaymentWebhookData(webhookBody);
    }
    return webhookBody?.data || webhookBody;
  }

  /**
   * Lấy thông tin thanh toán theo mã đơn
   */
  async getPaymentLinkInformation(orderCode) {
    if (!this.isConfigured()) {
      throw new Error('Cổng thanh toán PayOS chưa được cấu hình');
    }

    if (this.payOS.paymentRequests?.get) {
      return await this.payOS.paymentRequests.get(orderCode);
    }
    if (typeof this.payOS.getPaymentLinkInformation === 'function') {
      return await this.payOS.getPaymentLinkInformation(orderCode);
    }
    return null;
  }
}

const payosService = new PayosService();
module.exports = payosService;
