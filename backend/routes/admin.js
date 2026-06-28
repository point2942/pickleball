const router = require('express').Router();
const bcrypt = require('bcryptjs');
const supabase = require('../supabase');
const { adminMiddleware } = require('../middleware/auth');
const { creditPoints } = require('./points');

// ── 所有路由需要管理員身份 ──

// 儀表板統計
router.get('/dashboard', adminMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const [{ count: todayBookings }, { count: pendingPay }, { data: revenue }] = await Promise.all([
    supabase.from('bookings').select('*', { count: 'exact', head: true })
      .eq('date', today).not('status', 'eq', 'cancelled'),
    supabase.from('bookings').select('*', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase.from('bookings').select('price').eq('status', 'paid')
      .gte('paid_at', today + 'T00:00:00')
  ]);

  const todayRevenue = (revenue || []).reduce((s, b) => s + b.price, 0);
  res.json({ todayBookings, pendingPay, todayRevenue });
});

// 所有預約列表
router.get('/bookings', adminMiddleware, async (req, res) => {
  const { date, status, date_from, date_to } = req.query;
  let query = supabase.from('bookings')
    .select('id, court_id, date, hour, price, is_member_price, status, payment_method, paid_at, cancelled_at, created_at, order_id, members(name, phone)')
    .order('date', { ascending: false })
    .order('hour')
    .limit(500);

  if (date) query = query.eq('date', date);
  if (date_from) query = query.gte('date', date_from);
  if (date_to) query = query.lte('date', date_to);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ bookings: data || [] });
});

// 手動更新預約狀態（現場付款）
router.patch('/bookings/:id/pay', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  await supabase.from('bookings').update({
    status: 'paid', payment_method: 'cash', paid_at: new Date()
  }).eq('id', id);
  res.json({ ok: true });
});

// 管理員取消預約
router.delete('/bookings/:id', adminMiddleware, async (req, res) => {
  await supabase.from('bookings').update({
    status: 'cancelled', cancelled_at: new Date()
  }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ── 定價管理 ──

router.get('/prices', adminMiddleware, async (req, res) => {
  const { data } = await supabase.from('price_rules').select('*')
    .order('day_type').order('hour_start');
  res.json({ rules: data });
});

router.put('/prices/:id', adminMiddleware, async (req, res) => {
  const { label, hour_start, hour_end, price_member, price_non_member, day_type } = req.body;
  await supabase.from('price_rules').update({
    label, hour_start, hour_end, price_member, price_non_member,
    day_type: day_type || 'weekday',
    updated_at: new Date()
  }).eq('id', req.params.id);
  res.json({ ok: true });
});

router.post('/prices', adminMiddleware, async (req, res) => {
  const { label, hour_start, hour_end, price_member, price_non_member, day_type } = req.body;
  const { data, error } = await supabase.from('price_rules')
    .insert({ label, hour_start, hour_end, price_member, price_non_member, day_type: day_type || 'weekday' })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ rule: data });
});

router.delete('/prices/:id', adminMiddleware, async (req, res) => {
  await supabase.from('price_rules').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── 場地管理 ──

router.put('/courts/:id', adminMiddleware, async (req, res) => {
  const { name, description, price_override, is_active } = req.body;
  await supabase.from('courts').update({ name, description, price_override, is_active })
    .eq('id', req.params.id);
  res.json({ ok: true });
});

// ── 會員管理 ──

router.get('/members', adminMiddleware, async (req, res) => {
  const { data } = await supabase.from('members').select('*').order('created_at', { ascending: false });
  // 不回傳 password_hash 本身（雜湊值對前台無實際用途，且不應暴露），改回傳是否已設定密碼
  const members = (data || []).map(m => {
    const { password_hash, ...rest } = m;
    return { ...rest, has_password: !!password_hash };
  });
  res.json({ members });
});

router.patch('/members/:id/membership', adminMiddleware, async (req, res) => {
  const { is_member, expire_days } = req.body;
  const expire = new Date();
  expire.setDate(expire.getDate() + (expire_days || 365));
  await supabase.from('members').update({
    is_member,
    member_expire_at: is_member ? expire : null
  }).eq('id', req.params.id);
  res.json({ ok: true });
});

// 管理員代為重設會員密碼（適用於球友忘記密碼又無法收信的情況）
router.patch('/members/:id/reset-password', adminMiddleware, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '密碼至少需 6 個字元' });
  const hash = await bcrypt.hash(newPassword, 12);
  const { error } = await supabase.from('members').update({ password_hash: hash }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, message: '已重設該會員密碼' });
});

// 修改管理員密碼
router.post('/change-password', adminMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const { data: admin } = await supabase.from('admins').select('*').eq('id', req.admin.id).single();
  const valid = await bcrypt.compare(oldPassword, admin.password_hash);
  if (!valid) return res.status(400).json({ error: '舊密碼錯誤' });
  const hash = await bcrypt.hash(newPassword, 12);
  await supabase.from('admins').update({ password_hash: hash }).eq('id', req.admin.id);
  res.json({ ok: true });
});

// ── 假日管理 ──

router.get('/holidays', adminMiddleware, async (req, res) => {
  const { data } = await supabase.from('holidays').select('*').order('date');
  res.json({ holidays: data || [] });
});

router.post('/holidays', adminMiddleware, async (req, res) => {
  const { date, name } = req.body;
  if (!date || !name) return res.status(400).json({ error: '請填寫日期與名稱' });
  const { data, error } = await supabase.from('holidays')
    .insert({ date, name }).select().single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: '此日期已設定為假日' });
    return res.status(400).json({ error: error.message });
  }
  res.json({ holiday: data });
});

router.delete('/holidays/:id', adminMiddleware, async (req, res) => {
  await supabase.from('holidays').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── 點數管理 ──

// 管理員手動調整會員點數（正數=加點，負數=扣點），適用現場收現金儲值或人工修正
router.post('/members/:id/points-adjust', adminMiddleware, async (req, res) => {
  const { points, note } = req.body;
  if (!points || !Number.isInteger(points)) return res.status(400).json({ error: '請輸入有效的點數（整數）' });

  const { data: member } = await supabase.from('members').select('points_balance').eq('id', req.params.id).single();
  if (!member) return res.status(404).json({ error: '找不到會員' });
  if (points < 0 && member.points_balance + points < 0) return res.status(400).json({ error: '扣點數超過該會員餘額' });

  const newBalance = await creditPoints({
    memberId: req.params.id, points, type: 'admin_adjust',
    note: note || (points > 0 ? '管理員手動加點' : '管理員手動扣點')
  });
  res.json({ ok: true, newBalance });
});

// 查詢待確認的現場儲值訂單
router.get('/topup-orders', adminMiddleware, async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('topup_orders')
    .select('*, members(name, phone)')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data } = await query;
  res.json({ orders: data || [] });
});

// 確認現場儲值收款，正式加點數
router.patch('/topup-orders/:id/confirm', adminMiddleware, async (req, res) => {
  const { data: order } = await supabase.from('topup_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  if (order.status === 'paid') return res.status(400).json({ error: '此訂單已確認過' });

  await supabase.from('topup_orders').update({ status: 'paid', paid_at: new Date() }).eq('id', order.id);
  await creditPoints({
    memberId: order.member_id, points: order.points, type: 'topup',
    note: `現場儲值 NT$${order.amount} 取得 ${order.points} 點（管理員確認）`,
    refOrderId: 'TP' + order.id, paymentMethod: 'cash'
  });
  res.json({ ok: true });
});

router.delete('/topup-orders/:id', adminMiddleware, async (req, res) => {
  await supabase.from('topup_orders').update({ status: 'cancelled' }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ── 儲值方案管理 ──

router.get('/topup-plans', adminMiddleware, async (req, res) => {
  const { data } = await supabase.from('topup_plans').select('*').order('sort_order');
  res.json({ plans: data || [] });
});

router.post('/topup-plans', adminMiddleware, async (req, res) => {
  const { amount, points, label, sort_order } = req.body;
  const { data, error } = await supabase.from('topup_plans')
    .insert({ amount, points, label, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ plan: data });
});

router.put('/topup-plans/:id', adminMiddleware, async (req, res) => {
  const { amount, points, label, sort_order, is_active } = req.body;
  await supabase.from('topup_plans').update({ amount, points, label, sort_order, is_active }).eq('id', req.params.id);
  res.json({ ok: true });
});

router.delete('/topup-plans/:id', adminMiddleware, async (req, res) => {
  await supabase.from('topup_plans').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
