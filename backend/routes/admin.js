const router = require('express').Router();
const bcrypt = require('bcryptjs');
const supabase = require('../supabase');
const { adminMiddleware } = require('../middleware/auth');

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
  const { data } = await supabase.from('price_rules').select('*').order('hour_start');
  res.json({ rules: data });
});

router.put('/prices/:id', adminMiddleware, async (req, res) => {
  const { label, hour_start, hour_end, price_member, price_non_member } = req.body;
  await supabase.from('price_rules').update({
    label, hour_start, hour_end, price_member, price_non_member, updated_at: new Date()
  }).eq('id', req.params.id);
  res.json({ ok: true });
});

router.post('/prices', adminMiddleware, async (req, res) => {
  const { label, hour_start, hour_end, price_member, price_non_member } = req.body;
  const { data, error } = await supabase.from('price_rules')
    .insert({ label, hour_start, hour_end, price_member, price_non_member }).select().single();
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
  res.json({ members: data });
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

module.exports = router;
