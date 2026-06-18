const router = require('express').Router();
const supabase = require('../supabase');

// 取得定價規則（公開）
// ?date=YYYY-MM-DD  → 回傳該日適用的規則（自動判斷平日/假日）
// 不帶 date         → 同時回傳 weekday + holiday 兩組（前端用於顯示定價說明）
router.get('/', async (req, res) => {
  const { date } = req.query;

  if (date) {
    // 判斷是否為假日
    const d = new Date(date);
    const dow = d.getDay();
    let isHoliday = (dow === 0 || dow === 6);
    if (!isHoliday) {
      const { data: hd } = await supabase
        .from('holidays').select('id').eq('date', date).single();
      isHoliday = !!hd;
    }
    const dayType = isHoliday ? 'holiday' : 'weekday';
    const { data } = await supabase.from('price_rules').select('*')
      .eq('day_type', dayType).order('hour_start');
    return res.json({ rules: data || [], isHoliday, dayType });
  }

  // 不帶 date：回傳全部（前端定價說明用）
  const { data } = await supabase.from('price_rules').select('*')
    .order('day_type').order('hour_start');
  res.json({ rules: data || [] });
});

module.exports = router;
