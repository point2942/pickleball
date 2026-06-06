const router = require('express').Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const supabase = require('../supabase');

// 球友登入/註冊（手機號碼 + 姓名）
router.post('/member/login', async (req, res) => {
  const { phone, name } = req.body;
  if (!phone || !name) return res.status(400).json({ error: '請填寫手機與姓名' });
  if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: '手機格式錯誤' });

  // 查詢是否已有會員
  let { data: member } = await supabase
    .from('members').select('*').eq('phone', phone).single();

  if (!member) {
    // 自動建立帳號
    const { data: newMember, error } = await supabase
      .from('members').insert({ phone, name }).select().single();
    if (error) return res.status(500).json({ error: '建立帳號失敗' });
    member = newMember;
  } else {
    // 更新姓名（若不同）
    if (member.name !== name) {
      await supabase.from('members').update({ name }).eq('id', member.id);
      member.name = name;
    }
  }

  const now = new Date();
  const isMember = member.is_member &&
    member.member_expire_at && new Date(member.member_expire_at) > now;

  const token = jwt.sign(
    { id: member.id, phone: member.phone, name: member.name, isMember, role: 'member' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ token, user: { id: member.id, phone, name: member.name, isMember } });
});

// 管理員登入
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

// 初始化管理員（第一次部署時用，之後可刪除此 endpoint）
router.post('/admin/init', async (req, res) => {
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
