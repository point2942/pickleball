const router = require('express').Router();
const supabase = require('../supabase');

// 取得定價規則（公開）
router.get('/', async (req, res) => {
  const { data } = await supabase.from('price_rules').select('*').order('hour_start');
  res.json({ rules: data || [] });
});

module.exports = router;
