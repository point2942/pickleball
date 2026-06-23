require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// CORS：僅允許自己的網站網域呼叫 API（APP_URL 環境變數需設定為正式網址）
const allowedOrigin = process.env.APP_URL;
app.use(cors({
  origin: allowedOrigin || true, // 若未設定 APP_URL，暫時放寬避免誤鎖（建議盡快設定）
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api/admin', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use('/api/bookings', rateLimit({ windowMs: 60 * 1000, max: 30 }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/courts', require('./routes/courts'));
app.use('/api/prices', require('./routes/prices'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/admin', require('./routes/admin'));

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── 自動取消逾時未付款訂單（超過 20 分鐘的 pending 預約） ──
const supabase = require('./supabase');
const { sendLineNotify } = require('./notify');
const PAYMENT_TIMEOUT_MINUTES = 20;

async function cancelExpiredBookings() {
  try {
    const cutoff = new Date(Date.now() - PAYMENT_TIMEOUT_MINUTES * 60 * 1000).toISOString();
    const { data: expired } = await supabase
      .from('bookings')
      .select('id, court_id, date, hour, order_id, member_id, members(name)')
      .eq('status', 'pending')
      .lt('created_at', cutoff);

    if (!expired?.length) return;

    const ids = expired.map(b => b.id);
    await supabase.from('bookings').update({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancel_reason: 'payment_timeout'
    }).in('id', ids);

    const desc = expired.map(b => `場地${b.court_id} ${b.date} ${String(b.hour).padStart(2,'0')}:00`).join('\n  ');
    await sendLineNotify(`⏰ 逾時自動取消（超過${PAYMENT_TIMEOUT_MINUTES}分鐘未付款）\n  ${desc}`);
    console.log(`[auto-cancel] 已自動取消 ${ids.length} 筆逾時未付款預約`);
  } catch (e) {
    console.error('[auto-cancel] 執行失敗:', e.message);
  }
}

// 每分鐘檢查一次
setInterval(cancelExpiredBookings, 60 * 1000);
// 啟動時先跑一次
cancelExpiredBookings();
