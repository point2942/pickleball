const router = require('express').Router();
const supabase = require('../supabase');
const { adminMiddleware } = require('../middleware/auth');

// 取得啟用場地（公開，球友用）
router.get('/', async (req, res) => {
  const { all } = req.query;
  let query = supabase.from('courts').select('*').order('id');
  if (!all) query = query.eq('is_active', true);
  const { data } = await query;
  res.json({ courts: data || [] });
});

module.exports = router;
