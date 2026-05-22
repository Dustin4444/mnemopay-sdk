import 'dotenv/config';

const MAILEROO_API_URL = process.env.MAILEROO_API_URL || 'https://smtp.maileroo.com/api/v2/emails';
const MAILEROO_API_KEY = process.env.MAILEROO_API_KEY;
const MAILEROO_FROM = process.env.MAILEROO_FROM || 'jeremiah@getbizsuite.com';

const recipients = [
  { address: 'Support@IPQualityScore.com' },
  { address: 'report@scamadviser.com' },
];

const subject = 'Urgent false phishing classification for mnemopay.com - immediate review requested';

const plain = `IPQualityScore Support Team,

I am requesting an immediate manual review and correction of any phishing, scam, or malicious-risk classification currently associated with mnemopay.com.

The current classification is materially false and harmful. MnemoPay is a legitimate software project operated by J&B Enterprise LLC. It is an open-source SDK and hosted trust/governance platform for AI agents, with public documentation, a public GitHub repository, standard security documentation, and legitimate business use cases around agent identity, audit trails, memory, and payment governance.

There is no phishing flow, credential-harvesting page, deceptive impersonation, malware distribution, or consumer scam operating at mnemopay.com.

The false classification is already being surfaced by third-party reputation sites and is damaging the reputation of a legitimate business whose core product depends on trust and security. That makes accuracy especially important here.

Please provide the following:

1. The exact IPQS category, score, and reason currently applied to mnemopay.com.
2. The source or signal that caused the phishing or malicious-risk classification.
3. The URL path, sample, screenshot, or evidence relied on for the classification.
4. A manual review by your abuse/reputation team.
5. Removal or correction of the phishing/scam classification if no specific evidence exists.
6. Written confirmation when the classification has been corrected or rescored.

Relevant facts for review:

- Domain: https://mnemopay.com
- Operator: J&B Enterprise LLC
- Public repo: https://github.com/mnemopay/mnemopay-sdk
- Project type: open-source developer SDK and hosted AI-agent governance infrastructure
- License: Apache 2.0
- Contact: jeremiah@getbizsuite.com

If a specific URL, file, redirect, third-party embed, or automated heuristic triggered this result, send it to me so it can be investigated immediately. If there is no specific evidence, please remove the classification and propagate the correction through your downstream feeds.

Please treat this as urgent. A false phishing label on a legitimate security/trust product is not a minor scoring issue; it creates direct business harm and misleads users, partners, and downstream reputation services.

Regards,

Jeremiah Omiagbo
J&B Enterprise LLC
jeremiah@getbizsuite.com
https://mnemopay.com
`;

if (!MAILEROO_API_KEY) {
  throw new Error('MAILEROO_API_KEY is not set');
}

const response = await fetch(MAILEROO_API_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': MAILEROO_API_KEY,
  },
  body: JSON.stringify({
    from: { address: MAILEROO_FROM, display_name: 'Jeremiah Omiagbo / J&B Enterprise LLC' },
    to: recipients,
    subject,
    plain,
  }),
});

const data = await response.json().catch(() => ({}));
if (!response.ok || data.success === false) {
  throw new Error(data?.message || `Maileroo HTTP ${response.status}`);
}

console.log(JSON.stringify({
  ok: true,
  provider: 'maileroo',
  recipients: recipients.map((recipient) => recipient.address),
  referenceId: data?.data?.reference_id || data?.reference_id || null,
}, null, 2));
