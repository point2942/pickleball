const router = require('express').Router();
const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../supabase');
const { authMiddleware } = require('../middleware/auth');
const { sendLineNotify } = require('../notify');
const { creditPoints } = require('./points');

// ============ ECPay 綠界 ============

router.post('/ecpay/create', authMiddleware, async (req, res) => {
  const { bookingIds } = req.body;

  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, court_id, date, hour, price, member_id')
    .in('id', bookingIds)
    .eq('status', 'pending');

  if (!bookings?.length) return res.status(400).json({ error: '找不到有效預約' });
  if (bookings.some(b => b.member_id !== req.user.id))
    return res.status(403).json({ error: '無權限' });

  const totalAmount = bookings.reduce((s, b) => s + b.price, 0);
  const tradeNo = 'PB' + Date.now();
  const itemName = bookings.map(b => `場地${b.court_id}-${b.date}-${String(b.hour).padStart(2,'0')}h`).join('#');
  const returnURL = `${process.env.APP_URL}/api/payment/ecpay/callback`;
  const orderResultURL = `${process.env.APP_URL}/payment-result`;

  const params = {
    MerchantID: process.env.ECPAY_MERCHANT_ID,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: new Date().toLocaleString('zh-TW', {
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false
    }).replace(/\//g,'/'),
    PaymentType: 'aio',
    TotalAmount: totalAmount,
    TradeDesc: '匹克球場地預約',
    ItemName: itemName,
    ReturnURL: returnURL,
    OrderResultURL: orderResultURL,
    ChoosePayment: 'Credit',
    EncryptType: 1,
    ClientBackURL: `${process.env.APP_URL}/my-bookings`,
    CustomField1: bookingIds.join(',')
  };

  params.CheckMacValue = genECPayMac(params);

  // 存 tradeNo
  await supabase.from('bookings').update({ payment_ref: tradeNo })
    .in('id', bookingIds);

  // 回傳表單資料讓前端提交
  res.json({ url: process.env.ECPAY_API_URL, params });
});

router.post('/ecpay/callback', async (req, res) => {
  const data = req.body;
  const received = data.CheckMacValue;
  delete data.CheckMacValue;
  const expected = genECPayMac(data);

  if (received !== expected) return res.send('0|Error');
  if (data.RtnCode !== '1') return res.send('1|OK'); // 付款失敗

  const bookingIds = data.CustomField1.split(',');
  await supabase.from('bookings').update({
    status: 'paid',
    payment_method: 'ecpay',
    paid_at: new Date()
  }).in('id', bookingIds);

  await sendLineNotify(`✅ 付款成功（綠界）\n訂單：${data.MerchantTradeNo}\n金額：NT$${data.TradeAmt}`);
  res.send('1|OK');
});

router.post('/ecpay/topup-callback', async (req, res) => {
  const data = req.body;
  const received = data.CheckMacValue;
  delete data.CheckMacValue;
  const expected = genECPayMac(data);

  if (received !== expected) return res.send('0|Error');
  if (data.RtnCode !== '1') return res.send('1|OK'); // 付款失敗

  const orderId = data.CustomField1;
  const { data: order } = await supabase.from('topup_orders').select('*').eq('id', orderId).single();
  if (!order || order.status === 'paid') return res.send('1|OK'); // 避免重複加點

  await supabase.from('topup_orders').update({
    status: 'paid', paid_at: new Date()
  }).eq('id', order.id);

  await creditPoints({
    memberId: order.member_id, points: order.points, type: 'topup',
    note: `儲值 NT$${order.amount} 取得 ${order.points} 點`,
    refOrderId: 'TP' + order.id, paymentMethod: 'ecpay'
  });

  await sendLineNotify(`✅ 儲值成功（綠界）\n訂單：${data.MerchantTradeNo}\n金額：NT$${data.TradeAmt}\n取得點數：${order.points}`);
  res.send('1|OK');
});

function genECPayMac(params) {
  const sorted = Object.keys(params).sort()
    .reduce((acc, k) => { acc[k] = params[k]; return acc; }, {});
  let str = `HashKey=${process.env.ECPAY_HASH_KEY}&` +
    Object.entries(sorted).map(([k, v]) => `${k}=${v}`).join('&') +
    `&HashIV=${process.env.ECPAY_HASH_IV}`;
  str = encodeURIComponent(str).toLowerCase()
    .replace(/%20/g,'+').replace(/%21/g,'!').replace(/%28/g,'(')
    .replace(/%29/g,')').replace(/%2a/g,'*');
  return crypto.createHash('sha256').update(str).digest('hex').toUpperCase();
}

// ============ LINE Pay ============

router.post('/linepay/create', authMiddleware, async (req, res) => {
  const { bookingIds } = req.body;

  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, court_id, date, hour, price, member_id')
    .in('id', bookingIds)
    .eq('status', 'pending');

  if (!bookings?.length) return res.status(400).json({ error: '找不到有效預約' });
  if (bookings.some(b => b.member_id !== req.user.id))
    return res.status(403).json({ error: '無權限' });

  const totalAmount = bookings.reduce((s, b) => s + b.price, 0);
  const orderId = 'PB' + Date.now();

  const body = {
    amount: totalAmount,
    currency: 'TWD',
    orderId,
    packages: [{
      id: 'pkg1',
      amount: totalAmount,
      name: '匹克球場地預約',
      products: bookings.map(b => ({
        name: `場地${b.court_id} ${b.date} ${String(b.hour).padStart(2,'0')}:00`,
        quantity: 1,
        price: b.price
      }))
    }],
    redirectUrls: {
      confirmUrl: `${process.env.APP_URL}/api/payment/linepay/confirm`,
      cancelUrl: `${process.env.APP_URL}/payment-result?status=cancel`
    }
  };

  const nonce = Date.now().toString();
  const bodyStr = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', process.env.LINEPAY_CHANNEL_SECRET)
    .update(process.env.LINEPAY_CHANNEL_SECRET + '/v3/payments/request' + bodyStr + nonce)
    .digest('base64');

  try {
    const resp = await axios.post(
      `${process.env.LINEPAY_API_URL}/v3/payments/request`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-LINE-ChannelId': process.env.LINEPAY_CHANNEL_ID,
          'X-LINE-Authorization-Nonce': nonce,
          'X-LINE-Authorization': sig
        }
      }
    );

    if (resp.data.returnCode !== '0000')
      return res.status(400).json({ error: resp.data.returnMessage });

    // 儲存 transactionId
    await supabase.from('bookings').update({ payment_ref: orderId }).in('id', bookingIds);

    res.json({ paymentUrl: resp.data.info.paymentUrl.web });
  } catch (e) {
    res.status(500).json({ error: 'LINE Pay 建立失敗' });
  }
});

router.get('/linepay/confirm', async (req, res) => {
  const { transactionId, orderId } = req.query;

  const { data: bookings } = await supabase
    .from('bookings').select('id, price').eq('payment_ref', orderId);

  if (!bookings?.length) return res.redirect('/payment-result?status=error');

  const amount = bookings.reduce((s, b) => s + b.price, 0);
  const body = { amount, currency: 'TWD' };
  const nonce = Date.now().toString();
  const bodyStr = JSON.stringify(body);
  const path = `/v3/payments/${transactionId}/confirm`;
  const sig = crypto.createHmac('sha256', process.env.LINEPAY_CHANNEL_SECRET)
    .update(process.env.LINEPAY_CHANNEL_SECRET + path + bodyStr + nonce)
    .digest('base64');

  try {
    const resp = await axios.post(
      `${process.env.LINEPAY_API_URL}${path}`, body,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-LINE-ChannelId': process.env.LINEPAY_CHANNEL_ID,
          'X-LINE-Authorization-Nonce': nonce,
          'X-LINE-Authorization': sig
        }
      }
    );

    if (resp.data.returnCode === '0000') {
      await supabase.from('bookings').update({
        status: 'paid', payment_method: 'linepay', paid_at: new Date()
      }).in('id', bookings.map(b => b.id));

      await sendLineNotify(`✅ 付款成功（LINE Pay）\n訂單：${orderId}\n金額：NT$${amount}`);
      return res.redirect('/payment-result?status=success');
    }
    res.redirect('/payment-result?status=error');
  } catch {
    res.redirect('/payment-result?status=error');
  }
});

router.get('/linepay/topup-confirm', async (req, res) => {
  const { transactionId, orderId } = req.query;

  const { data: order } = await supabase.from('topup_orders').select('*').eq('payment_ref', orderId).single();
  if (!order) return res.redirect('/payment-result?status=error');
  if (order.status === 'paid') return res.redirect('/payment-result?status=success'); // 避免重複加點

  const body = { amount: order.amount, currency: 'TWD' };
  const nonce = Date.now().toString();
  const bodyStr = JSON.stringify(body);
  const path = `/v3/payments/${transactionId}/confirm`;
  const sig = crypto.createHmac('sha256', process.env.LINEPAY_CHANNEL_SECRET)
    .update(process.env.LINEPAY_CHANNEL_SECRET + path + bodyStr + nonce)
    .digest('base64');

  try {
    const resp = await axios.post(
      `${process.env.LINEPAY_API_URL}${path}`, body,
      { headers: {
          'Content-Type': 'application/json',
          'X-LINE-ChannelId': process.env.LINEPAY_CHANNEL_ID,
          'X-LINE-Authorization-Nonce': nonce,
          'X-LINE-Authorization': sig
      }}
    );

    if (resp.data.returnCode === '0000') {
      await supabase.from('topup_orders').update({
        status: 'paid', paid_at: new Date()
      }).eq('id', order.id);

      await creditPoints({
        memberId: order.member_id, points: order.points, type: 'topup',
        note: `儲值 NT$${order.amount} 取得 ${order.points} 點`,
        refOrderId: 'TP' + order.id, paymentMethod: 'linepay'
      });

      await sendLineNotify(`✅ 儲值成功（LINE Pay）\n訂單：${orderId}\n金額：NT$${order.amount}\n取得點數：${order.points}`);
      return res.redirect('/payment-result?status=success');
    }
    res.redirect('/payment-result?status=error');
  } catch {
    res.redirect('/payment-result?status=error');
  }
});

module.exports = router;
