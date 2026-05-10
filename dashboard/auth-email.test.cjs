const assert = require('assert');
const { codeEmail, sendAuthCodeEmail } = require('./auth-email.cjs');

async function main() {
  const email = codeEmail({ code: '123456', accountId: 'acct_1', ttlMinutes: 10 });
  assert(email.subject.includes('mnemopay'));
  assert(email.text.includes('123456'));
  assert(email.html.includes('123456'));

  const dev = await sendAuthCodeEmail({ to: 'a@example.com', code: '111111', accountId: 'acct_1' });
  assert.strictEqual(dev.delivered, false);
  assert.strictEqual(dev.provider, 'dev');

  const calls = [];
  const sent = await sendAuthCodeEmail({
    apiKey: 're_x',
    from: 'MnemoPay <login@example.com>',
    to: 'a@example.com',
    code: '222222',
    accountId: 'acct_2',
    requester: async (payload) => {
      calls.push(payload);
      return { id: 'email_1' };
    },
  });
  assert.strictEqual(sent.delivered, true);
  assert.strictEqual(sent.id, 'email_1');
  assert.strictEqual(calls[0].to, 'a@example.com');
  assert(calls[0].text.includes('222222'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
