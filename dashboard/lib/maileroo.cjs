/**
 * Thin Maileroo REST wrapper for transactional onboarding emails.
 *
 * Auth: X-API-Key header (not Bearer). See marketing/send-strategic-2026-05-06.js
 * for the canonical pattern — same auth shape, same v2 emails endpoint.
 *
 * Single export: `sendMailerooTemplate(to, templateId, vars)` for template-style
 * sends. We don't actually use Maileroo's hosted-template feature yet (none have
 * been created) — the function renders the templates defined below inline. This
 * keeps the drip self-contained while leaving room to migrate to Maileroo
 * templates later without changing call-sites.
 *
 * If MAILEROO_API_KEY is missing, every send no-ops (returns { delivered: false,
 * reason: 'MAILEROO_API_KEY not set' }). Callers should not crash on that.
 */

const https = require('https');

const DEFAULT_API_URL = 'https://smtp.maileroo.com/api/v2/emails';

function defaultRequester(apiKey, apiUrl) {
  return async function request(payload) {
    const body = JSON.stringify(payload);
    const parsed = new URL(apiUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let result;
          try { result = raw ? JSON.parse(raw) : {}; } catch { result = { message: raw }; }
          if (res.statusCode >= 400) {
            const err = new Error(result?.message || result?.error || `Maileroo HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.payload = result;
            reject(err);
            return;
          }
          resolve(result);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };
}

// ── Templates ──────────────────────────────────────────────────────────────
// One template per drip touch. Keep copy short, plain, no emojis. Sign as
// "Jeremiah". Pulls visible voice from marketing/send-strategic-2026-05-06.js.
function renderTemplate(templateId, vars = {}) {
  const v = vars || {};
  const apiKeyLine = v.apiKey
    ? `your api key (treat it like a password):\n\n  ${v.apiKey}\n\n`
    : 'your api key is in the welcome message in your account console. if you can\'t find it, just reply to this email.\n\n';

  switch (templateId) {
    case 'mnemopay-welcome': {
      return {
        subject: 'welcome to mnemopay — your api key + 60-second start',
        text:
`hey${v.firstName ? ' ' + v.firstName : ''},

you're in. ${v.tier ? `${v.tier} ` : ''}subscription is active.

${apiKeyLine}60-second start:

  npm install @mnemopay/sdk

  import MnemoPay from "@mnemopay/sdk";
  const agent = MnemoPay.quick("my-agent", { apiKey: process.env.MNEMOPAY_API_KEY });
  const tx = await agent.charge(0.49, "first charge");
  await agent.settle(tx.id);

that's the whole loop. full quickstart: https://github.com/mnemopay/mnemopay-sdk#quickstart
console: https://mnemopay.com/console

i answer this email directly — if anything blocks you, reply.

— jeremiah
jeremiah@getbizsuite.com`,
      };
    }

    case 'mnemopay-day-1': {
      return {
        subject: 'did you make your first call?',
        text:
`hey${v.firstName ? ' ' + v.firstName : ''},

24-hr check-in. did you get a first charge() through?

most people stall on one of three things:
  1. environment variable. MNEMOPAY_API_KEY needs to be on the process that imports the sdk.
  2. agent.charge() requires a real rail key in production. for testing, MnemoPay.quick() is in-memory and works with no rail.
  3. await ordering. settle() must come after charge() resolves — easy to forget in a try/catch.

integration docs (copy-paste, all three rails covered):
https://github.com/mnemopay/mnemopay-sdk#integrations

stuck? reply with the line that breaks and i'll send back the patch.

— jeremiah`,
      };
    }

    case 'mnemopay-day-3': {
      return {
        subject: 'common pattern: agent payments + memory together',
        text:
`hey${v.firstName ? ' ' + v.firstName : ''},

the pattern most pro customers settle on after the first week is:

  1. agent.remember() the user's intent at the start of a session
  2. agent.charge() per tool call
  3. agent.recall() before every llm prompt so the model sees its own past

the credit score (300-850) compounds across sessions automatically. agents that consistently settle clean transactions get fee discounts (1.5% → 1.0% at >800). that's the whole growth loop.

short example:
https://github.com/mnemopay/mnemopay-sdk#agent-memory-+-payments

if you have a use case you want a second pair of eyes on, send me the 2-sentence version and i'll sketch the right shape.

— jeremiah`,
      };
    }

    case 'mnemopay-day-7': {
      return {
        subject: 'a week in — anything blocking you?',
        text:
`hey${v.firstName ? ' ' + v.firstName : ''},

one-week check-in. two questions, no obligation to answer either:

  1. what's the one thing about mnemopay that's been worth the $${v.priceMonthly || '49'}/mo?
  2. what's the one thing that's been a blocker, dead-end, or "i wish this worked differently"?

i read every reply. the second question shapes the next release — the first one shapes how i talk about mnemopay to other founders.

reply with two sentences. or one. or just the blocker.

— jeremiah
jeremiah@getbizsuite.com`,
      };
    }

    default:
      throw new Error(`unknown template id: ${templateId}`);
  }
}

/**
 * Send a Maileroo email using one of the named templates above.
 *
 * @param {string|string[]} to — recipient email (or array of recipients)
 * @param {string} templateId — one of: mnemopay-welcome, mnemopay-day-1,
 *                              mnemopay-day-3, mnemopay-day-7
 * @param {object} vars — template variables (firstName, apiKey, tier, priceMonthly)
 * @param {object} opts — { apiKey, from, apiUrl, requester } overrides
 */
async function sendMailerooTemplate(to, templateId, vars = {}, opts = {}) {
  const apiKey = opts.apiKey || process.env.MAILEROO_API_KEY;
  const from = opts.from || process.env.MAILEROO_FROM || 'jeremiah@getbizsuite.com';
  const apiUrl = opts.apiUrl || process.env.MAILEROO_API_URL || DEFAULT_API_URL;

  if (!apiKey) {
    return { delivered: false, provider: 'maileroo', reason: 'MAILEROO_API_KEY not set' };
  }
  if (!to) {
    return { delivered: false, provider: 'maileroo', reason: 'recipient missing' };
  }

  const tpl = renderTemplate(templateId, vars);
  const recipients = Array.isArray(to) ? to : [to];

  // Maileroo v2 `to` field expects email objects, not bare strings.
  const body = {
    from: `Jeremiah Omiagbo <${from}>`,
    to: recipients.map((address) => ({ address })),
    subject: tpl.subject,
    plain: tpl.text,
  };

  const requester = opts.requester || defaultRequester(apiKey, apiUrl);
  try {
    const result = await requester(body);
    return {
      delivered: true,
      provider: 'maileroo',
      templateId,
      id: result?.id || result?.reference_id || null,
      response: result,
    };
  } catch (err) {
    return {
      delivered: false,
      provider: 'maileroo',
      templateId,
      reason: err.message,
      statusCode: err.statusCode || null,
    };
  }
}

module.exports = {
  sendMailerooTemplate,
  renderTemplate,
  defaultRequester,
};
