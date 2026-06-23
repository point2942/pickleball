const axios = require('axios');

const RESEND_API_URL = 'https://api.resend.com/emails';
// Resend 測試網域，免費方案下不需要自己的網域即可寄信
const FROM_ADDRESS = 'Pickleball 場地預約 <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[email] RESEND_API_KEY 未設定，無法寄信');
    return { ok: false, error: 'RESEND_API_KEY 未設定' };
  }
  try {
    const res = await axios.post(RESEND_API_URL, {
      from: FROM_ADDRESS,
      to: [to],
      subject,
      html
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    return { ok: true, id: res.data?.id };
  } catch (e) {
    console.error('[email] Resend 寄信失敗:', e.response?.data || e.message);
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

async function sendPasswordResetEmail(to, resetUrl) {
  return sendEmail({
    to,
    subject: '匹克球場地預約 - 重設密碼',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#0a6e4e">重設密碼</h2>
        <p>您好，我們收到您重設密碼的請求。請點擊下方按鈕設定新密碼（連結 30 分鐘內有效）：</p>
        <p style="text-align:center;margin:32px 0">
          <a href="${resetUrl}" style="background:#0a6e4e;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">重設密碼</a>
        </p>
        <p style="color:#9ca3af;font-size:13px">若您沒有提出此請求，請忽略此信件，您的密碼將不會被更改。</p>
        <p style="color:#9ca3af;font-size:13px">若按鈕無法點擊，請複製以下連結到瀏覽器：<br>${resetUrl}</p>
      </div>
    `
  });
}

module.exports = { sendEmail, sendPasswordResetEmail };
