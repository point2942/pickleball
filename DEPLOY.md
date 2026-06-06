# 匹克球場地預約系統 — 部署完整指南

## 系統架構
```
前端 HTML/CSS/JS  ──┐
                    ├── Node.js (Render 免費主機)
後台 admin.html ────┘        │
                             ▼
                     Supabase (免費資料庫)
                             │
                    LINE Notify / 綠界 / LINE Pay
```

---

## STEP 1｜建立 Supabase 資料庫

1. 前往 https://supabase.com 點 **Start for free**，用 GitHub 登入
2. 點 **New project**，填入：
   - Project name：`pickleball`
   - Database Password：記下來備用
   - Region：**Southeast Asia (Singapore)**（台灣最近）
3. 等候 ~2 分鐘建立完成
4. 左側點 **SQL Editor** → 點 **New query**
5. 將 `backend/schema.sql` 全部內容貼上 → 點 **Run**
6. 確認右下角顯示 `Success`

**取得連線資訊：**
- 左側點 **Settings → API**
- 複製 **Project URL** → 這是 `SUPABASE_URL`
- 複製 **service_role** 下的 key → 這是 `SUPABASE_SERVICE_KEY`
  ⚠️ 注意：要用 `service_role`，不是 `anon`

---

## STEP 2｜取得 LINE Notify Token

1. 前往 https://notify-bot.line.me 用 LINE 帳號登入
2. 右上點你的名字 → **個人頁面**
3. 下滑到「**發行存取權杖（開發人員用）**」→ 點 **發行**
4. Token 名稱填：`匹克球場地通知`，選「**1對1傳送**」→ 發行
5. 複製 Token → 這是 `LINE_NOTIFY_TOKEN`

> 之後每次有人預約、取消、付款，通知都會傳到你的 LINE

---

## STEP 3｜申請綠界金流 (ECPay)

1. 前往 https://www.ecpay.com.tw → **立即加入**
2. 選「**特店申請**」，填入商家資料
3. 審核通過後登入後台
4. **開發測試期間**先用測試環境：
   - Merchant ID：`2000132`（測試用）
   - Hash Key：`5294y06JbISpM5x9`
   - Hash IV：`v77hoKGq4kWxNNIS`
   - API URL：`https://payment-stage.ecpay.com.tw/Cashier/AioCheckout`
5. 正式上線時換成真實的商家 ID / Key / IV，並改 API URL 為：
   `https://payment.ecpay.com.tw/Cashier/AioCheckout`

---

## STEP 4｜申請 LINE Pay（選填）

1. 前往 https://pay.line.me/tw → **商家申請**
2. 填寫商家資料，等待審核（約 3-5 個工作天）
3. 審核通過後取得 **Channel ID** 和 **Channel Secret Key**
4. 測試期間可用 Sandbox：https://sandbox-api-pay.line.me

---

## STEP 5｜部署到 Render

1. 將整個 `pickleball` 資料夾推上 GitHub（新建 repo）：
   ```bash
   cd pickleball
   git init
   git add .
   git commit -m "init"
   git remote add origin https://github.com/你的帳號/pickleball.git
   git push -u origin main
   ```

2. 前往 https://render.com 用 GitHub 登入
3. 點 **New → Web Service**
4. 選你剛建的 GitHub repo
5. 設定：
   - **Name**：`pickleball-booking`
   - **Root Directory**：`backend`
   - **Build Command**：`npm install`
   - **Start Command**：`node server.js`
   - **Instance Type**：Free

6. 點 **Advanced → Add Environment Variable** 逐一填入：

   | Key | Value |
   |-----|-------|
   | SUPABASE_URL | 步驟1取得的URL |
   | SUPABASE_SERVICE_KEY | 步驟1取得的service_role key |
   | JWT_SECRET | 隨機字串（可用密碼產生器生成32位） |
   | LINE_NOTIFY_TOKEN | 步驟2取得的token |
   | ECPAY_MERCHANT_ID | 綠界商家ID |
   | ECPAY_HASH_KEY | 綠界Hash Key |
   | ECPAY_HASH_IV | 綠界Hash IV |
   | ECPAY_API_URL | 測試: https://payment-stage.ecpay.com.tw/Cashier/AioCheckout |
   | LINEPAY_CHANNEL_ID | LINE Pay Channel ID |
   | LINEPAY_CHANNEL_SECRET | LINE Pay Channel Secret |
   | LINEPAY_API_URL | 測試: https://sandbox-api-pay.line.me |
   | APP_URL | 留空，部署後再填 |

7. 點 **Create Web Service**，等待部署（約 3-5 分鐘）
8. 部署完成後複製網址（例如：`https://pickleball-booking.onrender.com`）
9. 回到 Render → Environment → 將 `APP_URL` 設為該網址 → Save
10. Render 會自動重新部署

---

## STEP 6｜建立第一個管理員帳號

部署完成後，執行一次初始化（用 curl 或 Postman）：

```bash
curl -X POST https://你的網址.onrender.com/api/auth/admin/init \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "你設定的JWT_SECRET",
    "email": "admin@yourdomain.com",
    "password": "你的強密碼",
    "name": "管理員"
  }'
```

> ⚠️ 建立成功後，建議在 `backend/routes/auth.js` 中刪除 `/admin/init` 這個 endpoint，再重新部署，避免被惡意呼叫

---

## STEP 7｜前端靜態檔案部署

`frontend/public/` 裡的 `index.html` 和 `admin.html` 已經由 backend Express 一起服務，不需要另外部署。

- 球友預約頁：`https://你的網址.onrender.com/`
- 後台管理頁：`https://你的網址.onrender.com/admin.html`

---

## 測試確認清單

- [ ] 球友登入（手機 + 姓名）
- [ ] 查看場地時間表
- [ ] 選取 1~4 個時段
- [ ] 確認預約 + 選付款方式
- [ ] 綠界測試付款（信用卡號：4311-9522-2222-2222）
- [ ] LINE Notify 收到通知
- [ ] 我的預約顯示已付款
- [ ] 後台登入 admin.html
- [ ] 後台查看今日預約
- [ ] 後台修改定價
- [ ] 後台標記現場付款
- [ ] 後台升級會員

---

## 正式上線前注意事項

1. **綠界換正式環境**：`ECPAY_API_URL` 改為 `https://payment.ecpay.com.tw/Cashier/AioCheckout`
2. **LINE Pay 換正式環境**：`LINEPAY_API_URL` 改為 `https://api-pay.line.me`
3. **綁定自訂網域**（建議）：Render 支援自訂網域，在 Settings → Custom Domain 設定
4. **Render 免費版限制**：閒置 15 分鐘會休眠，首次請求約等 30 秒。若需 24 小時不休眠，升級為 Starter ($7/月)

---

## 檔案結構總覽

```
pickleball/
├── backend/
│   ├── server.js          # 主程式入口
│   ├── supabase.js        # 資料庫連線
│   ├── notify.js          # LINE Notify
│   ├── schema.sql         # 資料庫建表 SQL
│   ├── package.json
│   ├── .env.example       # 環境變數範本
│   ├── middleware/
│   │   └── auth.js        # JWT 驗證中介層
│   └── routes/
│       ├── auth.js        # 登入/註冊
│       ├── bookings.js    # 預約/取消
│       ├── courts.js      # 場地查詢
│       ├── prices.js      # 定價查詢
│       ├── payment.js     # 綠界 & LINE Pay
│       └── admin.js       # 後台管理 API
├── frontend/
│   └── public/
│       ├── index.html     # 球友預約前台
│       └── admin.html     # 管理員後台
└── render.yaml            # Render 部署設定
```
