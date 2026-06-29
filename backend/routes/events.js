const router = require('express').Router();
const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../supabase');
const { authMiddleware, adminMiddleware, optionalAuthMiddleware } = require('../middleware/auth');
const { sendLineNotify } = require('../notify');
const { creditPoints } = require('./points');

// ── 查詢開放中的活動列表（公開） ──
router.get('/', async (req, res) => {
  const { data: events } = await supabase
    .from('events').select('*')
    .neq('status', 'cancelled')
    .gte('event_date', new Date().toISOString().slice(0, 10))
    .order('event_date');

  // 附上目前已確認報名人數，方便前端顯示名額
  const result = [];
  for (const ev of events || []) {
    const { count } = await supabase
      .from('event_registrations').select('*', { count: 'exact', head: true })
      .eq('event_id', ev.id).eq('status', 'confirmed');
    result.push({ ...ev, confirmed_count: count || 0, spots_left: Math.max(0, ev.capacity - (count || 0)) });
  }
  res.json({ events: result });
});

// ── 查詢單一活動詳情（公開） ──
router.get('/:id', async (req, res) => {
  const { data: event } = await supabase.from('events').select('*').eq('id', req.params.id).single();
  if (!event) return res.status(404).json({ error: '找不到此活動' });

  const { count } = await supabase
    .from('event_registrations').select('*', { count: 'exact', head: true })
    .eq('event_id', event.id).eq('status', 'confirmed');

  res.json({ event: { ...event, confirmed_count: count || 0, spots_left: Math.max(0, event.capacity - (count || 0)) } });
});

// ── 報名活動（會員或訪客皆可，optionalAuth 判斷身份） ──
router.post('/:id/register', optionalAuthMiddleware, async (req, res) => {
  const eventId = req.params.id;
  const { guestName, guestPhone, usePoints, paymentMethod } = req.body;
  const isGuest = !req.user;

  if (isGuest && (!guestName || !guestPhone)) {
    return res.status(400).json({ error: '請填寫姓名與手機號碼' });
  }
  if (isGuest && !/^09\d{8}$/.test(guestPhone)) {
    return res.status(400).json({ error: '手機格式錯誤' });
  }
  if (isGuest && paymentMethod === 'cash') {
    return res.status(400).json({ error: '訪客報名僅支援線上付款' });
  }

  const { data: event } = await supabase.from('events').select('*').eq('id', eventId).single();
  if (!event) return res.status(404).json({ error: '找不到此活動' });
  if (event.status !== 'open') return res.status(400).json({ error: '此活動目前未開放報名' });
  if (event.registration_deadline && new Date(event.registration_deadline) < new Date()) {
    return res.status(400).json({ error: '已超過報名截止時間' });
  }

  // 同一人（會員或同手機號）不可重複報名同一場活動
  let dupQuery = supabase.from('event_registrations').select('id').eq('event_id', eventId).neq('status', 'cancelled');
  dupQuery = req.user ? dupQuery.eq('member_id', req.user.id) : dupQuery.eq('guest_phone', guestPhone);
  const { data: existing } = await dupQuery;
  if (existing?.length > 0) return res.status(409).json({ error: '您已經報名過此活動' });

  const { count: confirmedCount } = await supabase
    .from('event_registrations').select('*', { count: 'exact', head: true })
    .eq('event_id', eventId).eq('status', 'confirmed');

  const hasSpot = (confirmedCount || 0) < event.capacity;
  const fee = event.fee || 0;

  // ── 點數折抵（僅會員可用） ──
  let pointsToUse = 0;
  if (req.user && usePoints > 0 && fee > 0) {
    const { data: member } = await supabase.from('members').select('points_balance').eq('id', req.user.id).single();
    const balance = member?.points_balance || 0;
    if (usePoints > balance) return res.status(400).json({ error: `點數不足，目前餘額 ${balance} 點` });
    pointsToUse = Math.min(usePoints, fee);
  }
  const remainingFee = fee - pointsToUse;

  // ── 建立報名記錄 ──
  const baseRow = {
    event_id: eventId,
    member_id: req.user?.id || null,
    guest_name: isGuest ? guestName : req.user.name,
    guest_phone: isGuest ? guestPhone : req.user.phone,
    fee,
    points_used: pointsToUse
  };

  if (!hasSpot) {
    // 名額已滿，加入候補
    const { count: waitlistCount } = await supabase
      .from('event_registrations').select('*', { count: 'exact', head: true })
      .eq('event_id', eventId).eq('status', 'waitlist');

    const { data: reg, error } = await supabase.from('event_registrations').insert({
      ...baseRow, status: 'waitlist', queue_position: (waitlistCount || 0) + 1
    }).select().single();
    if (error) return res.status(500).json({ error: '報名失敗' });

    await sendLineNotify(`🕐 活動候補\n活動：${event.title}\n姓名：${baseRow.guest_name}（${baseRow.guest_phone}）\n候補序號：第 ${reg.queue_position} 位`);
    return res.json({ ok: true, status: 'waitlist', queuePosition: reg.queue_position, message: `名額已滿，您已加入候補第 ${reg.queue_position} 位` });
  }

  // 免費活動或點數全額折抵 → 直接確認名額
  if (remainingFee === 0) {
    const { data: reg, error } = await supabase.from('event_registrations').insert({
      ...baseRow, status: 'confirmed',
      payment_method: pointsToUse > 0 ? 'points' : null,
      paid_at: fee > 0 ? new Date() : null
    }).select().single();
    if (error) return res.status(500).json({ error: '報名失敗' });

    if (pointsToUse > 0) {
      await creditPoints({
        memberId: req.user.id, points: -pointsToUse, type: 'spend',
        note: `活動報名「${event.title}」折抵 ${pointsToUse} 點`, refOrderId: 'EVT' + reg.id, paymentMethod: 'points'
      });
    }

    await checkAndNotifyFull(event, eventId);
    await sendLineNotify(`✅ 活動報名成功\n活動：${event.title}\n姓名：${baseRow.guest_name}（${baseRow.guest_phone}）${fee > 0 ? `\n費用：NT$${fee}（${pointsToUse > 0 ? '點數折抵' : '免費'}）` : ''}`);
    return res.json({ ok: true, status: 'confirmed', message: '報名成功！' });
  }

  // 需要線上付款的情況：先建立 pending 報名記錄，付款成功後 callback 才轉為 confirmed
  if (!paymentMethod || paymentMethod === 'cash') {
    return res.status(400).json({ error: '此活動需要線上付款，請選擇信用卡或 LINE Pay' });
  }

  const { data: reg, error } = await supabase.from('event_registrations').insert({
    ...baseRow, status: 'pending', payment_method: paymentMethod
  }).select().single();
  if (error) return res.status(500).json({ error: '報名失敗' });

  if (pointsToUse > 0) {
    await creditPoints({
      memberId: req.user.id, points: -pointsToUse, type: 'spend',
      note: `活動報名「${event.title}」折抵 ${pointsToUse} 點（待補足差額）`, refOrderId: 'EVT' + reg.id, paymentMethod: 'points'
    });
  }

  if (paymentMethod === 'ecpay') {
    const tradeNo = 'EVT' + Date.now();
    const params = {
      MerchantID: process.env.ECPAY_MERCHANT_ID,
      MerchantTradeNo: tradeNo,
      MerchantTradeDate: new Date().toLocaleString('zh-TW', {
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false
      }).replace(/\//g,'/'),
      PaymentType: 'aio',
      TotalAmount: remainingFee,
      TradeDesc: '活動報名費',
      ItemName: event.title,
      ReturnURL: `${process.env.APP_URL}/api/payment/ecpay/event-callback`,
      OrderResultURL: `${process.env.APP_URL}/payment-result`,
      ChoosePayment: 'Credit',
      EncryptType: 1,
      ClientBackURL: `${process.env.APP_URL}/`,
      CustomField1: String(reg.id)
    };
    params.CheckMacValue = genECPayMac(params);
    await supabase.from('event_registrations').update({ payment_ref: tradeNo }).eq('id', reg.id);
    return res.json({ ok: true, status: 'pending', gateway: 'ecpay', url: process.env.ECPAY_API_URL, params });
  }

  if (paymentMethod === 'linepay') {
    const linePayOrderId = 'EVT' + Date.now();
    const body = {
      amount: remainingFee, currency: 'TWD', orderId: linePayOrderId,
      packages: [{ id: 'event', amount: remainingFee, name: event.title,
        products: [{ name: event.title, quantity: 1, price: remainingFee }] }],
      redirectUrls: {
        confirmUrl: `${process.env.APP_URL}/api/payment/linepay/event-confirm`,
        cancelUrl: `${process.env.APP_URL}/payment-result?status=cancel`
      }
    };
    const nonce = Date.now().toString();
    const bodyStr = JSON.stringify(body);
    const sig = crypto.createHmac('sha256', process.env.LINEPAY_CHANNEL_SECRET)
      .update(process.env.LINEPAY_CHANNEL_SECRET + '/v3/payments/request' + bodyStr + nonce)
      .digest('base64');
    try {
      const resp = await axios.post(`${process.env.LINEPAY_API_URL}/v3/payments/request`, body, {
        headers: { 'Content-Type': 'application/json', 'X-LINE-ChannelId': process.env.LINEPAY_CHANNEL_ID,
          'X-LINE-Authorization-Nonce': nonce, 'X-LINE-Authorization': sig }
      });
      if (resp.data.returnCode !== '0000') return res.status(400).json({ error: resp.data.returnMessage });
      await supabase.from('event_registrations').update({ payment_ref: linePayOrderId }).eq('id', reg.id);
      return res.json({ ok: true, status: 'pending', gateway: 'linepay', paymentUrl: resp.data.info.paymentUrl.web });
    } catch {
      return res.status(500).json({ error: 'LINE Pay 建立失敗' });
    }
  }

  res.status(400).json({ error: '不支援的付款方式' });
});

// ── 取消報名（會員本人或訪客憑電話查詢取消） ──
router.post('/:id/cancel-registration', optionalAuthMiddleware, async (req, res) => {
  const { guestPhone, registrationId } = req.body;
  let query = supabase.from('event_registrations').select('*').eq('id', registrationId).eq('event_id', req.params.id);
  const { data: reg } = await query.single();
  if (!reg) return res.status(404).json({ error: '找不到報名記錄' });

  if (req.user) {
    if (reg.member_id !== req.user.id) return res.status(403).json({ error: '無權限' });
  } else {
    if (!guestPhone || reg.guest_phone !== guestPhone) return res.status(403).json({ error: '手機號碼不符，無法取消' });
  }
  if (reg.status === 'cancelled') return res.json({ ok: true });

  await supabase.from('event_registrations').update({ status: 'cancelled', cancelled_at: new Date() }).eq('id', reg.id);

  if (reg.points_used > 0 && reg.member_id) {
    await creditPoints({
      memberId: reg.member_id, points: reg.points_used, type: 'refund',
      note: `活動報名取消退回點數`, refOrderId: 'EVT' + reg.id, paymentMethod: 'points'
    });
  }

  await sendLineNotify(`❌ 活動報名取消\n姓名：${reg.guest_name}（${reg.guest_phone}）`);

  // 若取消的是已確認名額，觸發候補轉正
  if (reg.status === 'confirmed' || reg.status === undefined) {
    await promoteWaitlist(reg.event_id);
  }

  res.json({ ok: true });
});

// ── 候補轉正邏輯（共用函式） ──
async function promoteWaitlist(eventId) {
  const { data: event } = await supabase.from('events').select('*').eq('id', eventId).single();
  if (!event) return;

  const { count: confirmedCount } = await supabase
    .from('event_registrations').select('*', { count: 'exact', head: true })
    .eq('event_id', eventId).eq('status', 'confirmed');

  const openSpots = event.capacity - (confirmedCount || 0);
  if (openSpots <= 0) return;

  const { data: waitlist } = await supabase
    .from('event_registrations').select('*')
    .eq('event_id', eventId).eq('status', 'waitlist')
    .order('queue_position').limit(openSpots);

  for (const w of waitlist || []) {
    await supabase.from('event_registrations').update({ status: 'confirmed' }).eq('id', w.id);
    await sendLineNotify(`🎉 候補轉正\n活動：${event.title}\n姓名：${w.guest_name}（${w.guest_phone}）已從候補轉為正式名額`);
  }
}

async function checkAndNotifyFull(event, eventId) {
  const { count } = await supabase
    .from('event_registrations').select('*', { count: 'exact', head: true })
    .eq('event_id', eventId).eq('status', 'confirmed');
  if (count >= event.capacity) {
    await sendLineNotify(`📢 活動名額已滿\n活動：${event.title}\n名額：${event.capacity} 人已全數報名`);
  }
}

// ── 管理員：活動 CRUD ──
router.get('/admin/list', adminMiddleware, async (req, res) => {
  const { data } = await supabase.from('events').select('*').order('event_date', { ascending: false });
  res.json({ events: data || [] });
});

router.post('/admin/create', adminMiddleware, async (req, res) => {
  const { title, description, event_date, start_hour, end_hour, location, capacity, fee, registration_deadline } = req.body;
  if (!title || !event_date || capacity == null) return res.status(400).json({ error: '請填寫必要欄位' });
  const { data, error } = await supabase.from('events').insert({
    title, description, event_date, start_hour, end_hour, location, capacity, fee: fee || 0, registration_deadline
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ event: data });
});

router.put('/admin/:id', adminMiddleware, async (req, res) => {
  const { title, description, event_date, start_hour, end_hour, location, capacity, fee, registration_deadline, status } = req.body;
  await supabase.from('events').update({
    title, description, event_date, start_hour, end_hour, location, capacity, fee, registration_deadline, status
  }).eq('id', req.params.id);
  res.json({ ok: true });
});

router.delete('/admin/:id', adminMiddleware, async (req, res) => {
  await supabase.from('events').update({ status: 'cancelled' }).eq('id', req.params.id);
  res.json({ ok: true });
});

router.get('/admin/:id/registrations', adminMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('event_registrations').select('*, members(name, phone)')
    .eq('event_id', req.params.id)
    .neq('status', 'cancelled')
    .order('status').order('queue_position');
  res.json({ registrations: data || [] });
});

router.post('/admin/registrations/:id/cancel', adminMiddleware, async (req, res) => {
  const { data: reg } = await supabase.from('event_registrations').select('*').eq('id', req.params.id).single();
  if (!reg) return res.status(404).json({ error: '找不到報名記錄' });
  if (reg.status === 'cancelled') return res.json({ ok: true });

  await supabase.from('event_registrations').update({ status: 'cancelled', cancelled_at: new Date() }).eq('id', reg.id);

  if (reg.points_used > 0 && reg.member_id) {
    await creditPoints({
      memberId: reg.member_id, points: reg.points_used, type: 'refund',
      note: `管理員取消活動報名退回點數`, refOrderId: 'EVT' + reg.id, paymentMethod: 'points'
    });
  }
  await promoteWaitlist(reg.event_id);
  res.json({ ok: true });
});

function genECPayMac(params) {
  const sorted = Object.keys(params).sort().reduce((acc, k) => { acc[k] = params[k]; return acc; }, {});
  let str = `HashKey=${process.env.ECPAY_HASH_KEY}&` +
    Object.entries(sorted).map(([k, v]) => `${k}=${v}`).join('&') +
    `&HashIV=${process.env.ECPAY_HASH_IV}`;
  str = encodeURIComponent(str).toLowerCase()
    .replace(/%20/g,'+').replace(/%21/g,'!').replace(/%28/g,'(')
    .replace(/%29/g,')').replace(/%2a/g,'*');
  return crypto.createHash('sha256').update(str).digest('hex').toUpperCase();
}

module.exports = { router, promoteWaitlist };
