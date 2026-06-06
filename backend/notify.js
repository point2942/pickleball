const axios = require('axios');

async function sendLineNotify(message) {
  const token = process.env.LINE_NOTIFY_TOKEN;
  if (!token) return;
  try {
    await axios.post(
      'https://notify-api.line.me/api/notify',
      `message=${encodeURIComponent('\n' + message)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
  } catch (e) {
    console.error('LINE Notify error:', e.response?.data || e.message);
  }
}

module.exports = { sendLineNotify };
