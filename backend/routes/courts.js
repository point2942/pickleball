const router = require('express').Router();
const supabase = require('../supabase');

// 取得所有場地（公開）
router.get('/', async (req, res) => {
  const { data } = await supabase
    .from('courts').select('*').eq('is_active', true).order('id');
  res.json({ courts: data || [] });
});

module.exports = router;
