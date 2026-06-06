-- =============================================
-- 匹克球場地預約系統 - Supabase Schema
-- 在 Supabase > SQL Editor 執行此檔案
-- =============================================

-- 會員表
CREATE TABLE members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(50) NOT NULL,
  is_member BOOLEAN DEFAULT false,
  member_expire_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 管理員表
CREATE TABLE admins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name VARCHAR(50) NOT NULL DEFAULT '管理員',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 場地設定表
CREATE TABLE courts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(20) NOT NULL,
  description TEXT,
  price_override JSONB,  -- 若有各場地個別定價 {member: N, non_member: N}
  is_active BOOLEAN DEFAULT true
);

-- 插入 8 面場地
INSERT INTO courts (name) VALUES
  ('場地 1'), ('場地 2'), ('場地 3'), ('場地 4'),
  ('場地 5'), ('場地 6'), ('場地 7'), ('場地 8');

-- 時段定價規則表（依小時區間）
CREATE TABLE price_rules (
  id SERIAL PRIMARY KEY,
  label VARCHAR(30) NOT NULL,        -- e.g. '離峰', '正常', '尖峰'
  hour_start INTEGER NOT NULL,       -- 0-23
  hour_end INTEGER NOT NULL,         -- 0-23 inclusive
  price_member INTEGER NOT NULL,
  price_non_member INTEGER NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 初始定價
INSERT INTO price_rules (label, hour_start, hour_end, price_member, price_non_member) VALUES
  ('深夜離峰', 0,  5,  400, 500),
  ('白天正常', 6, 18,  640, 800),
  ('晚間時段', 19, 23, 480, 600);

-- 預約表
CREATE TABLE bookings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id UUID REFERENCES members(id),
  court_id INTEGER REFERENCES courts(id),
  date DATE NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
  price INTEGER NOT NULL,
  is_member_price BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- status: pending | paid | cancelled
  payment_method VARCHAR(20),
  -- payment_method: ecpay | linepay | cash | null
  payment_ref VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  UNIQUE(court_id, date, hour)
);

-- 通知 log 表
CREATE TABLE notify_logs (
  id SERIAL PRIMARY KEY,
  booking_id UUID REFERENCES bookings(id),
  message TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);

-- INDEX
CREATE INDEX idx_bookings_date ON bookings(date);
CREATE INDEX idx_bookings_member ON bookings(member_id);
CREATE INDEX idx_bookings_status ON bookings(status);

-- RLS: 關閉（後端用 service_role key，不走 RLS）
ALTER TABLE members DISABLE ROW LEVEL SECURITY;
ALTER TABLE bookings DISABLE ROW LEVEL SECURITY;
ALTER TABLE courts DISABLE ROW LEVEL SECURITY;
ALTER TABLE price_rules DISABLE ROW LEVEL SECURITY;
ALTER TABLE admins DISABLE ROW LEVEL SECURITY;
