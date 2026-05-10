const https = require('https');

function defaultRequester(apiKey) {
  return async function request(payload) {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { message: raw };
          }
          if (res.statusCode >= 400) {
            const err = new Error(parsed?.message || parsed?.error || `Resend HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.payload = parsed;
            reject(err);
            return;
          }
          resolve(parsed);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };
}

function codeEmail({ code, accountId, ttlMinutes = 10 }) {
  return {
    subject: 'your mnemopay console code',
    text: [
      `Your MnemoPay console code is ${code}.`,
      '',
      `Account: ${accountId}`,
      `Expires in ${ttlMinutes} minutes.`,
      '',
      'If you did not request this, ignore this email.',
    ].join('\n'),
    html: [
      '<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#101828">',
      '<p>Your MnemoPay console code is:</p>',
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>`,
      `<p>Account: <code>${accountId}</code></p>`,
      `<p>This code expires in ${ttlMinutes} minutes.</p>`,
      '<p style="color:#667085">If you did not request this, ignore this email.</p>',
      '</div>',
    ].join(''),
  };
}

async function sendAuthCodeEmail({ apiKey, from, to, code, accountId, requester }) {
  if (!apiKey) return { delivered: false, provider: 'dev', reason: 'RESEND_API_KEY not set' };
  if (!from) return { delivered: false, provider: 'resend', reason: 'MNEMOPAY_AUTH_EMAIL_FROM not set' };
  const email = codeEmail({ code, accountId });
  const send = requester || defaultRequester(apiKey);
  const result = await send({
    from,
    to,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  return { delivered: true, provider: 'resend', id: result.id || null };
}

module.exports = {
  codeEmail,
  defaultRequester,
  sendAuthCodeEmail,
};
