# Shop Bot MMO — Hệ Thống Bán Tài Khoản Số Tự Động

> Storefront web app bán tài khoản số tự động 24/7 với thanh toán VietQR qua PayOS, giao hàng tức thì sau khi xác nhận chuyển khoản.

## ✨ Tính năng

- **Storefront đẹp** — Giao diện premium dark mode, responsive, product cards với real-time stock
- **Thanh toán VietQR tự động** — Tích hợp PayOS, tạo mã QR, auto-polling xác nhận thanh toán
- **Giao hàng tức thì** — Nhận tài khoản ngay sau khi chuyển khoản thành công
- **Admin Dashboard** — Thống kê doanh thu, quản lý đơn hàng, users, cấu hình markup
- **Retry & Manual Delivery** — Admin có thể giao lại hoặc cấp tay khi kho thiếu vốn
- **Bảo mật** — JWT auth, rate limiting, idempotency keys, CORS, Helmet

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS, Google Fonts (Inter, Outfit, JetBrains Mono) |
| Backend | Node.js, Express.js |
| Database | SQLite (better-sqlite3) với WAL mode |
| Payment | PayOS VietQR API |
| Security | JWT, bcrypt, express-rate-limit, helmet |

## 🚀 Cài đặt

```bash
# Clone repo
git clone https://github.com/NguyenHoangPhuong275/MMO.git
cd MMO

# Cài dependencies
npm install

# Tạo file cấu hình
cp .env.example .env
# Sửa .env với API keys của bạn

# Chạy server
node server.js
```

Server chạy tại `http://localhost:3000`

## 📁 Cấu trúc project

```
├── server.js              # Express server + API routes
├── database.js            # SQLite schema + data layer
├── services/
│   ├── cacheService.js    # Product catalog cache
│   ├── payosService.js    # PayOS payment gateway
│   ├── msbService.js      # MSB bank direct (fallback)
│   ├── upstreamService.js # Supplier API integration
│   ├── vietQrService.js   # VietQR URL builder
│   ├── msbPaymentReconciler.js
│   └── depositReconciler.js
├── public/
│   ├── index.html         # SPA storefront
│   ├── css/style.css      # Full design system
│   ├── js/app.js          # Frontend logic + admin panel
│   └── images/            # Product images
├── .env.example           # Environment template
├── package.json
└── README.md
```

## 🔑 Tài khoản mặc định

Khi chạy lần đầu, hệ thống tự tạo admin account:
- **Username**: `admin`
- **Password**: In ra console (hoặc set `ADMIN_PASSWORD` trong `.env`)

## 📄 License

MIT
