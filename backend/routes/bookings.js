const router = require('express').Router();
const supabase = require('../supabase');
const { authMiddleware } = require('../middleware/auth');
const { sendLineNotify } = require('../notify');

// 查詢某日場地狀況（公開）
router.get('/schedule', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: '請提供日期' });

  const { data, error } = await supabase
    .from('bookings')
    .select('court_id, hour, status, members(name)')
    .eq('date', date)
    .in('status', ['pending', 'paid']);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ bookings: data });
});

// 取得定價（公開）
router.get('/price', async (req, res) => {
  const { court_id, hour, is_member } = req.query;
  const price = await calcPrice(parseInt(court_id), parseInt(hour), is_member === 'true');
  res.json({ price });
});

// 建立預約（需登入，最多4個時段）
router.post('/', authMiddleware, async (req, res) => {
  const { slots } = req.body;
  // slots: [{court_id, date, hour}, ...]
  if (!slots || !Array.isArray(slots) || slots.length === 0)
    return res.status(400).json({ error: '請選擇時段' });
  if (slots.length > 4)
    return res.status(400).json({ error: '每次最多預約 4 個時段' });

  const memberId = req.user.id;
  const isMember = req.user.isMember;

  // 計算每個時段價格並建立
  const rows = [];
  for (const s of slots) {
    const price = await calcPrice(s.court_id, s.hour, isMember);
    rows.push({
      member_id: memberId,
      court_id: s.court_id,
      date: s.date,
      hour: s.hour,
      price,
      is_member_price: isMember,
      status: 'pending'
    });
  }

  const { data, error } = await supabase
    .from('bookings').insert(rows).select('id, court_id, date, hour, price, status');

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: '部分時段已被預約，請重新選擇' });
    return res.status(500).json({ error: error.message });
  }

  // LINE Notify
  const totalPrice = rows.reduce((s, r) => s + r.price, 0);
  const slotDesc = rows.map(r => `場地${r.court_id} ${r.date} ${String(r.hour).padStart(2,'0')}:00`).join('\n  ');
  await sendLineNotify(
    `📋 新預約\n球友：${req.user.name}（${req.user.phone}）\n  ${slotDesc}\n合計：NT$${totalPrice}\n狀態：待付款`
  );

  res.json({ bookings: data, totalPrice });
});

// 取消預約（需登入，只能取消自己的）
router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const memberId = req.user.id;

  const { data: booking } = await supabase
    .from('bookings').select('*').eq('id', id).single();

  if (!booking) return res.status(404).json({ error: '找不到預約' });
  if (booking.member_id !== memberId) return res.status(403).json({ error: '無權限' });
  if (booking.status === 'paid') return res.status(400).json({ error: '已付款訂單請聯絡管理員取消' });

  await supabase.from('bookings').update({
    status: 'cancelled', cancelled_at: new Date()
  }).eq('id', id);

  await sendLineNotify(`❌ 預約取消\n球友：${req.user.name}\n場地${booking.court_id} ${booking.date} ${String(booking.hour).padStart(2,'0')}:00`);

  res.json({ ok: true });
});

// 查詢我的預約
router.get('/mine', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('bookings')
    .select('id, court_id, date, hour, price, status, payment_method, paid_at')
    .eq('member_id', req.user.id)
    .not('status', 'eq', 'cancelled')
    .order('date', { ascending: true })
    .order('hour', { ascending: true });

  res.json({ bookings: data || [] });
});

// Helper: 計算價格
async function calcPrice(courtId, hour, isMember) {
  // 先查場地個別定價
  const { data: court } = await supabase
    .from('courts').select('price_override').eq('id', courtId).single();

  if (court?.price_override) {
    return isMember ? court.price_override.member : court.price_override.non_member;
  }

  // 查時段定價規則
  const { data: rules } = await supabase.from('price_rules').select('*');
  const rule = rules?.find(r => hour >= r.hour_start && hour <= r.hour_end);
  if (!rule) return isMember ? 500 : 600;
  return isMember ? rule.price_member : rule.price_non_member;
}

module.exports = router;
