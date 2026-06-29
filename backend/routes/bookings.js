const router = require('express').Router();
const supabase = require('../supabase');
const { authMiddleware } = require('../middleware/auth');
const { sendLineNotify } = require('../notify');
const { creditPoints } = require('./points');

const MAX_BOOKING_DAYS = 90; // 只能預約未來 90 天（約 3 個月）內的時段

// Helper: 檢查日期是否在可預約範圍內（今天 ~ 今天+60天）
function isWithinBookingWindow(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + MAX_BOOKING_DAYS);
  return target >= today && target <= maxDate;
}

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
  const { court_id, hour, is_member, date } = req.query;
  const price = await calcPrice(parseInt(court_id), parseInt(hour), is_member === 'true', date);
  res.json({ price });
});

// 建立預約（需登入，最多5個時段，同批用同一 order_id）
// usePoints：本次想用多少點數折抵（選填，不可超過餘額，也不可超過訂單總額）
router.post('/', authMiddleware, async (req, res) => {
  const { slots, usePoints } = req.body;
  if (!slots || !Array.isArray(slots) || slots.length === 0)
    return res.status(400).json({ error: '請選擇時段' });
  if (slots.length > 5)
    return res.status(400).json({ error: '每次最多預約 5 個時段' });

  // 檢查每個時段的日期是否都在可預約範圍內
  for (const s of slots) {
    if (!isWithinBookingWindow(s.date)) {
      return res.status(400).json({ error: `僅開放未來 ${MAX_BOOKING_DAYS} 天內的預約，${s.date} 超出範圍` });
    }
  }

  const memberId = req.user.id;
  const isMember = req.user.isMember;
  const orderId = 'ORD' + Date.now(); // 同批預約共用同一訂單號

  const rows = [];
  for (const s of slots) {
    const price = await calcPrice(s.court_id, s.hour, isMember, s.date);
    rows.push({
      member_id: memberId,
      court_id: s.court_id,
      date: s.date,
      hour: s.hour,
      price,
      is_member_price: isMember,
      status: 'pending',
      order_id: orderId
    });
  }

  const totalPrice = rows.reduce((s, r) => s + r.price, 0);

  // ── 點數折抵 ──
  let pointsToUse = 0;
  if (usePoints && usePoints > 0) {
    const { data: member } = await supabase.from('members').select('points_balance').eq('id', memberId).single();
    const balance = member?.points_balance || 0;
    if (usePoints > balance) return res.status(400).json({ error: `點數不足，目前餘額 ${balance} 點` });
    pointsToUse = Math.min(usePoints, totalPrice); // 折抵金額不可超過訂單總額
  }

  // 點數平均分配到各時段（用於記錄，付款邏輯仍以訂單整體計算）
  if (pointsToUse > 0) {
    let remaining = pointsToUse;
    for (let i = 0; i < rows.length; i++) {
      const isLast = i === rows.length - 1;
      const portion = isLast ? remaining : Math.min(rows[i].price, Math.round(pointsToUse * rows[i].price / totalPrice));
      rows[i].points_used = portion;
      remaining -= portion;
    }
  }

  const remainingAfterPoints = totalPrice - pointsToUse;
  // 若點數已折抵全額，訂單直接視為已付款（現場/線上不需再收費）
  if (pointsToUse > 0 && remainingAfterPoints === 0) {
    rows.forEach(r => { r.status = 'paid'; r.payment_method = 'points'; r.paid_at = new Date(); });
  }

  const { data, error } = await supabase
    .from('bookings').insert(rows).select('id, court_id, date, hour, price, points_used, status, order_id');

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: '部分時段已被預約，請重新選擇' });
    return res.status(500).json({ error: error.message });
  }

  // 扣點數（建立成功才扣，避免時段衝突卻已扣點的情況）
  if (pointsToUse > 0) {
    await creditPoints({
      memberId, points: -pointsToUse, type: 'spend',
      note: `訂單 ${orderId} 折抵 ${pointsToUse} 點`,
      refOrderId: orderId, paymentMethod: 'points'
    });
  }

  const slotDesc = rows.map(r => `場地${r.court_id} ${r.date} ${String(r.hour).padStart(2,'0')}:00`).join('\n  ');
  const pointsLine = pointsToUse > 0 ? `\n折抵點數：${pointsToUse} 點` : '';
  await sendLineNotify(
    `📋 新預約\n球友：${req.user.name}（${req.user.phone}）\n  ${slotDesc}\n合計：NT$${totalPrice}${pointsLine}\n狀態：${remainingAfterPoints === 0 && pointsToUse > 0 ? '已付款（點數全額折抵）' : '待付款'}`
  );

  res.json({ bookings: data, totalPrice, pointsUsed: pointsToUse, remainingAmount: remainingAfterPoints, orderId });
});

// 取消預約（需登入，只能取消自己的）
router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const memberId = req.user.id;

  const { data: booking } = await supabase
    .from('bookings').select('*').eq('id', id).single();

  if (!booking) return res.status(404).json({ error: '找不到預約' });
  if (booking.member_id !== memberId) return res.status(403).json({ error: '無權限' });
  if (booking.status === 'cancelled') return res.json({ ok: true }); // 已是取消狀態，避免重複退點
  // 純點數付款（全額折抵）的訂單可自行取消並退點；信用卡/LinePay 付款的訂單需管理員協助退款
  if (booking.status === 'paid' && booking.payment_method !== 'points') {
    return res.status(400).json({ error: '已付款訂單請聯絡管理員取消' });
  }

  await supabase.from('bookings').update({
    status: 'cancelled', cancelled_at: new Date()
  }).eq('id', id);

  // 若該時段先前有折抵點數（訂單尚未全額付清，狀態為 pending），取消時退回點數
  if (booking.points_used > 0) {
    await creditPoints({
      memberId, points: booking.points_used, type: 'refund',
      note: `取消預約退回點數（場地${booking.court_id} ${booking.date} ${String(booking.hour).padStart(2,'0')}:00）`,
      refOrderId: booking.order_id, paymentMethod: 'points'
    });
  }

  await sendLineNotify(`❌ 預約取消\n球友：${req.user.name}\n場地${booking.court_id} ${booking.date} ${String(booking.hour).padStart(2,'0')}:00`);

  res.json({ ok: true });
});

// 查詢我的預約（依 order_id 分組）
router.get('/mine', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('bookings')
    .select('id, court_id, date, hour, price, status, payment_method, paid_at, created_at, order_id')
    .eq('member_id', req.user.id)
    .not('status', 'eq', 'cancelled')
    .order('created_at', { ascending: false })
    .order('hour', { ascending: true });

  const PAYMENT_TIMEOUT_MINUTES = 20;

  // 依 order_id 分組
  const orders = {};
  (data || []).forEach(b => {
    const oid = b.order_id || b.id;
    if (!orders[oid]) {
      orders[oid] = {
        order_id: oid,
        created_at: b.created_at,
        status: b.status,
        payment_method: b.payment_method,
        paid_at: b.paid_at,
        expires_at: new Date(new Date(b.created_at).getTime() + PAYMENT_TIMEOUT_MINUTES * 60 * 1000).toISOString(),
        bookings: [],
        total: 0
      };
    }
    orders[oid].bookings.push(b);
    orders[oid].total += b.price;
    // 若有任一筆已付款，整組標為已付款
    if (b.status === 'paid') orders[oid].status = 'paid';
  });

  res.json({ orders: Object.values(orders) });
});

// Helper: 判斷某日期是否為假日（週六日 或 手動假日）
async function isHoliday(dateStr) {
  const d = new Date(dateStr);
  const dow = d.getDay(); // 0=日, 6=六
  if (dow === 0 || dow === 6) return true;

  const { data } = await supabase
    .from('holidays').select('id').eq('date', dateStr).single();
  return !!data;
}

// Helper: 計算價格（支援假日定價）
async function calcPrice(courtId, hour, isMember, dateStr) {
  // 1. 場地個別定價覆蓋（不區分平假日）
  const { data: court } = await supabase
    .from('courts').select('price_override').eq('id', courtId).single();

  if (court?.price_override) {
    return isMember ? court.price_override.member : court.price_override.non_member;
  }

  // 2. 依平日/假日套用不同定價規則
  const holiday = dateStr ? await isHoliday(dateStr) : false;
  const dayType = holiday ? 'holiday' : 'weekday';

  const { data: rules } = await supabase
    .from('price_rules').select('*').eq('day_type', dayType);

  const rule = rules?.find(r => hour >= r.hour_start && hour <= r.hour_end);
  if (!rule) {
    // fallback：找平日規則
    const { data: fallback } = await supabase
      .from('price_rules').select('*').eq('day_type', 'weekday');
    const fr = fallback?.find(r => hour >= r.hour_start && hour <= r.hour_end);
    if (!fr) return isMember ? 500 : 600;
    return isMember ? fr.price_member : fr.price_non_member;
  }
  return isMember ? rule.price_member : rule.price_non_member;
}

module.exports = router;