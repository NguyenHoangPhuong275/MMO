function buildVietQrUrl({ bankBin, accountNumber, accountName, amountVnd, memo }) {
  const normalizedAmount = Number(amountVnd);
  if (!bankBin || !accountNumber || !Number.isInteger(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error('Cấu hình VietQR hoặc số tiền không hợp lệ');
  }

  const params = new URLSearchParams({
    amount: String(normalizedAmount),
    addInfo: String(memo || '').slice(0, 25),
    accountName: String(accountName || '')
  });

  return `https://img.vietqr.io/image/${encodeURIComponent(bankBin)}-${encodeURIComponent(accountNumber)}-compact2.png?${params.toString()}`;
}

module.exports = { buildVietQrUrl };
