const router = require('express').Router();
const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { sendLineNotify } = require('../notify');

// ── 查詢儲值方案（公開） ──
router.get('/plans', async (req, res) => {
  const { data } = await supabase
    .from('topup_plans').select('*').eq('is_active', true).order('sort_order');
  res.json({ plans: data || [] });
});

// ── 查詢自己的點數餘額與明細（需登入） ──
router.get('/balance', authMiddleware, async (req, res) => {
  const { data: member } = await supabase
    .from('members').select('points_balance').eq('id', req.user.id).single();
  res.json({ balance: member?.points_balance || 0 });
});

router.get('/transactions', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('points_transactions').select('*')
    .eq('member_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  res.json({ transactions: data || [] });
});

// ── 建立儲值訂單：現場付款（直接由本人發起，但實際加點需管理員在後台確認收款後執行，此處僅建立 pending 記錄） ──
// 註：若你希望球友線上自選「現場付款」儲值，仍是建立 pending 訂單，等你收到款後在後台手動加點（見 admin.js）

router.post('/topup/create', authMiddleware, async (req, res) => {
  const { planId, method } = req.body; // method: 'cash' | 'ecpay' | 'linepay'
  if (!planId || !method) return res.status(400).json({ error: '請選擇方案與付款方式' });

  const { data: plan } = await supabase
    .from('topup_plans').select('*').eq('id', planId).eq('is_active', true).single();
  if (!plan) return res.status(400).json({ error: '方案不存在或已停用' });

  const { data: order, error } = await supabase.from('topup_orders').insert({
    member_id: req.user.id,
    plan_id: plan.id,
    amount: plan.amount,
    points: plan.points,
    status: 'pending',
    payment_method: method
  }).select().single();

  if (error) return res.status(500).json({ error: '建立儲值訂單失敗' });

  if (method === 'cash') {
    await sendLineNotify(`💰 新儲值訂單（現場付款待確認）\n球友：${req.user.name}（${req.user.phone}）\n方案：NT$${plan.amount} → ${plan.points} 點\n訂單編號：${order.id}`);
    return res.json({ ok: true, order, message: '訂單已建立，請現場付款，待管理員確認收款後將自動加值點數' });
  }

  if (method === 'ecpay') {
    const tradeNo = 'TP' + Date.now();
    const params = {
      MerchantID: process.env.ECPAY_MERCHANT_ID,
      MerchantTradeNo: tradeNo,
      MerchantTradeDate: new Date().toLocaleString('zh-TW', {
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false
      }).replace(/\//g,'/'),
      PaymentType: 'aio',
      TotalAmount: plan.amount,
      TradeDesc: '匹克球點數儲值',
      ItemName: `儲值方案-${plan.label || plan.amount}`,
      ReturnURL: `${process.env.APP_URL}/api/payment/ecpay/topup-callback`,
      OrderResultURL: `${process.env.APP_URL}/payment-result`,
      ChoosePayment: 'Credit',
      EncryptType: 1,
      ClientBackURL: `${process.env.APP_URL}/my-bookings`,
      CustomField1: String(order.id)
    };
    params.CheckMacValue = genECPayMac(params);
    await supabase.from('topup_orders').update({ payment_ref: tradeNo }).eq('id', order.id);
    return res.json({ ok: true, gateway: 'ecpay', url: process.env.ECPAY_API_URL, params });
  }

  if (method === 'linepay') {
    const linePayOrderId = 'TP' + Date.now();
    const body = {
      amount: plan.amount,
      currency: 'TWD',
      orderId: linePayOrderId,
      packages: [{
        id: 'topup',
        amount: plan.amount,
        name: '匹克球點數儲值',
        products: [{ name: `儲值方案 NT$${plan.amount} → ${plan.points}點`, quantity: 1, price: plan.amount }]
      }],
      redirectUrls: {
        confirmUrl: `${process.env.APP_URL}/api/payment/linepay/topup-confirm`,
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
        `${process.env.LINEPAY_API_URL}/v3/payments/request`, body,
        { headers: {
            'Content-Type': 'application/json',
            'X-LINE-ChannelId': process.env.LINEPAY_CHANNEL_ID,
            'X-LINE-Authorization-Nonce': nonce,
            'X-LINE-Authorization': sig
        }}
      );
      if (resp.data.returnCode !== '0000') return res.status(400).json({ error: resp.data.returnMessage });

      await supabase.from('topup_orders').update({ payment_ref: linePayOrderId }).eq('id', order.id);
      return res.json({ ok: true, gateway: 'linepay', paymentUrl: resp.data.info.paymentUrl.web });
    } catch (e) {
      return res.status(500).json({ error: 'LINE Pay 建立失敗' });
    }
  }

  res.status(400).json({ error: '不支援的付款方式' });
});

// ── 實際加點數的共用函式（供 payment.js callback 與 admin.js 呼叫） ──
async function creditPoints({ memberId, points, type, note, refOrderId, paymentMethod }) {
  const { data: member } = await supabase
    .from('members').select('points_balance').eq('id', memberId).single();
  const newBalance = (member?.points_balance || 0) + points;

  await supabase.from('members').update({ points_balance: newBalance }).eq('id', memberId);
  await supabase.from('points_transactions').insert({
    member_id: memberId, type, points, balance_after: newBalance,
    note, ref_order_id: refOrderId, payment_method: paymentMethod
  });
  return newBalance;
}

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

module.exports = { router, creditPoints };
