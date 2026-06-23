const router = require('express').Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const supabase = require('../supabase');
const { sendPasswordResetEmail } = require('../email');

function signMemberToken(member, isMember) {
  return jwt.sign(
    { id: member.id, phone: member.phone, name: member.name, isMember, role: 'member' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function computeIsMember(member) {
  const now = new Date();
  return !!(member.is_member && member.member_expire_at && new Date(member.member_expire_at) > now);
}

// ── 球友註冊（手機 + 姓名 + Email + 密碼） ──
router.post('/member/register', async (req, res) => {
  const { phone, name, email, password } = req.body;
  if (!phone || !name || !email || !password)
    return res.status(400).json({ error: '請填寫手機、姓名、Email、密碼' });
  if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: '手機格式錯誤' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email 格式錯誤' });
  if (password.length < 6) return res.status(400).json({ error: '密碼至少需 6 個字元' });

  const { data: existing } = await supabase
    .from('members').select('id, password_hash').eq('phone', phone).single();

  if (existing && existing.password_hash) {
    return res.status(409).json({ error: '此手機號碼已註冊，請改用登入' });
  }

  const hash = await bcrypt.hash(password, 12);

  let member;
  if (existing) {
    // 舊會員補登：補上 email + 密碼
    const { data, error } = await supabase
      .from('members').update({ name, email, password_hash: hash }).eq('id', existing.id)
      .select().single();
    if (error) return res.status(500).json({ error: '更新帳號失敗' });
    member = data;
  } else {
    const { data, error } = await supabase
      .from('members').insert({ phone, name, email, password_hash: hash }).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: '此手機號碼已被使用' });
      return res.status(500).json({ error: '建立帳號失敗' });
    }
    member = data;
  }

  const isMember = computeIsMember(member);
  const token = signMemberToken(member, isMember);
  res.json({ token, user: { id: member.id, phone: member.phone, name: member.name, isMember } });
});

// ── 球友登入（手機 + 密碼） ──
router.post('/member/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: '請填寫手機與密碼' });

  const { data: member } = await supabase
    .from('members').select('*').eq('phone', phone).single();

  if (!member) return res.status(401).json({ error: '帳號或密碼錯誤' });

  if (!member.password_hash) {
    // 舊會員尚未設定密碼，引導前端走補登流程
    return res.status(409).json({ error: 'NEEDS_SETUP', code: 'NEEDS_SETUP', message: '此帳號尚未設定密碼，請先完成帳號設定' });
  }

  const valid = await bcrypt.compare(password, member.password_hash);
  if (!valid) return res.status(401).json({ error: '帳號或密碼錯誤' });

  const isMember = computeIsMember(member);
  const token = signMemberToken(member, isMember);
  res.json({ token, user: { id: member.id, phone: member.phone, name: member.name, isMember } });
});

// ── 忘記密碼：發送重設連結 ──
router.post('/member/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '請輸入 Email' });

  const { data: member } = await supabase
    .from('members').select('id, email').eq('email', email).single();

  // 無論是否找到帳號，都回覆相同訊息，避免洩漏帳號是否存在
  const genericMsg = { ok: true, message: '若該 Email 已註冊，重設密碼信件將會寄出，請查收信箱' };

  if (!member) return res.json(genericMsg);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 分鐘

  await supabase.from('password_resets').insert({
    member_id: member.id, token, expires_at: expiresAt
  });

  const appUrl = process.env.APP_URL || '';
  const resetUrl = `${appUrl}/reset-password.html?token=${token}`;
  await sendPasswordResetEmail(member.email, resetUrl);

  res.json(genericMsg);
});

// ── 重設密碼：用 token 設定新密碼 ──
router.post('/member/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: '請提供重設連結與新密碼' });
  if (password.length < 6) return res.status(400).json({ error: '密碼至少需 6 個字元' });

  const { data: resetReq } = await supabase
    .from('password_resets').select('*').eq('token', token).single();

  if (!resetReq) return res.status(400).json({ error: '重設連結無效' });
  if (resetReq.used) return res.status(400).json({ error: '此連結已被使用過' });
  if (new Date(resetReq.expires_at) < new Date()) return res.status(400).json({ error: '重設連結已過期，請重新申請' });

  const hash = await bcrypt.hash(password, 12);
  await supabase.from('members').update({ password_hash: hash }).eq('id', resetReq.member_id);
  await supabase.from('password_resets').update({ used: true }).eq('id', resetReq.id);

  res.json({ ok: true, message: '密碼已重設成功，請使用新密碼登入' });
});

// ── 管理員登入 ──
router.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '請填寫帳號密碼' });

  const { data: admin } = await supabase
    .from('admins').select('*').eq('email', email).single();

  if (!admin) return res.status(401).json({ error: '帳號或密碼錯誤' });

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: '帳號或密碼錯誤' });

  const token = jwt.sign(
    { id: admin.id, email: admin.email, name: admin.name, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, admin: { email: admin.email, name: admin.name } });
});

// ── 初始化管理員 ──
// 僅在環境變數 ALLOW_ADMIN_INIT=true 時才開放，平時應保持關閉或不設定
router.post('/admin/init', async (req, res) => {
  if (process.env.ALLOW_ADMIN_INIT !== 'true') {
    return res.status(403).json({ error: '此功能目前未開放' });
  }

  const { secret, email, password, name } = req.body;
  if (secret !== process.env.JWT_SECRET) return res.status(403).json({ error: '禁止' });

  const { data: existing } = await supabase.from('admins').select('id').limit(1);
  if (existing?.length > 0) return res.status(400).json({ error: '管理員已存在' });

  const hash = await bcrypt.hash(password, 12);
  const { error } = await supabase.from('admins').insert({ email, password_hash: hash, name: name || '管理員' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, message: '管理員建立成功' });
});

module.exports = router;
