/**
 * lqmoni — Liquid Protocol Monitor Bot
 * Single file. Alchemy webhook → Telegram channel.
 * On start: sends the latest token deployment to Telegram (smoke test).
 * Then: receives Alchemy webhooks in real-time.
 */
import express from 'express';
import { createPublicClient, http, decodeEventLog, decodeFunctionData } from 'viem';
import { base } from 'viem/chains';
import { createHmac } from 'crypto';

// ─── Config ────────────────────────────────────────────────────────────────
const FACTORY     = process.env.FACTORY_ADDRESS  || '0x04F1a284168743759BE6554f607a10CEBdB77760';
const RPC_URL     = process.env.RPC_URL          || 'https://mainnet.base.org';
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID;
const SIGN_KEY    = process.env.ALCHEMY_SIGNING_KEY || ''; // optional: verify webhook signature
const PORT        = process.env.PORT || 3000;

if (!TG_TOKEN || !TG_CHAT) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

// ─── Constants ─────────────────────────────────────────────────────────────
const HOOKS = {
  '0x9811f10cd549c754fa9e5785989c422a762c28cc': 'StaticFee',
  '0x80e2f7dc8c2c880bbc4bdf80a5fb0eb8b1db68cc': 'DynamicFee',
};
const MEVS = {
  '0x187e8627c02c58f31831953c1268e157d3bfcefd': 'SniperAuction',
  '0x8d6b080e48756a99f3893491d556b5d6907b6910': 'DescendingFees',
  '0x2b6cd5be183c388dd0074d53c52317df1414cd9f': 'SniperUtil',
};
const WETH = '0x4200000000000000000000000000000000000006';

const TOKEN_CREATED_EVENT = {
  type: 'event', name: 'TokenCreated',
  inputs: [
    { name: 'msgSender',        type: 'address',   indexed: false },
    { name: 'tokenAddress',     type: 'address',   indexed: true  },
    { name: 'tokenAdmin',       type: 'address',   indexed: true  },
    { name: 'tokenImage',       type: 'string',    indexed: false },
    { name: 'tokenName',        type: 'string',    indexed: false },
    { name: 'tokenSymbol',      type: 'string',    indexed: false },
    { name: 'tokenMetadata',    type: 'string',    indexed: false },
    { name: 'tokenContext',     type: 'string',    indexed: false },
    { name: 'startingTick',     type: 'int24',     indexed: false },
    { name: 'poolHook',         type: 'address',   indexed: false },
    { name: 'poolId',           type: 'bytes32',   indexed: false },
    { name: 'pairedToken',      type: 'address',   indexed: false },
    { name: 'locker',           type: 'address',   indexed: false },
    { name: 'mevModule',        type: 'address',   indexed: false },
    { name: 'extensionsSupply', type: 'uint256',   indexed: false },
    { name: 'extensions',       type: 'address[]', indexed: false },
  ],
};

// ABI for decoding input data (selector 0xdf40224a)
const DEPLOY_ABI = [{
  type: 'function', name: 'deployToken', stateMutability: 'payable',
  inputs: [{ name: 'c', type: 'tuple', components: [
    { name: 'tokenConfig', type: 'tuple', components: [
      { name: 'tokenAdmin', type: 'address' }, { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' }, { name: 'salt', type: 'bytes32' },
      { name: 'image', type: 'string' }, { name: 'metadata', type: 'string' },
      { name: 'context', type: 'string' }, { name: 'originatingChainId', type: 'uint256' },
    ]},
    { name: 'poolConfig', type: 'tuple', components: [
      { name: 'hook', type: 'address' }, { name: 'pairedToken', type: 'address' },
      { name: 'tickIfToken0IsLiquid', type: 'int24' }, { name: 'tickSpacing', type: 'int24' },
      { name: 'poolData', type: 'bytes' },
    ]},
    { name: 'lockerConfig', type: 'tuple', components: [
      { name: 'locker', type: 'address' }, { name: 'rewardAdmins', type: 'address[]' },
      { name: 'rewardRecipients', type: 'address[]' }, { name: 'rewardBps', type: 'uint16[]' },
      { name: 'tickLower', type: 'int24[]' }, { name: 'tickUpper', type: 'int24[]' },
      { name: 'positionBps', type: 'uint16[]' }, { name: 'lockerData', type: 'bytes' },
    ]},
    { name: 'mevModuleConfig', type: 'tuple', components: [
      { name: 'mevModule', type: 'address' }, { name: 'mevModuleData', type: 'bytes' },
    ]},
    { name: 'extensionConfigs', type: 'tuple[]', components: [
      { name: 'extension', type: 'address' }, { name: 'extensionSupply', type: 'uint256' },
      { name: 'extensionBps', type: 'uint16' }, { name: 'extensionData', type: 'bytes' },
    ]},
  ]}],
  outputs: [{ type: 'address' }],
}];

// ─── Viem client ────────────────────────────────────────────────────────────
const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

// ─── Helpers ────────────────────────────────────────────────────────────────
function tickToMcap(tick) {
  const m = Math.pow(1.0001, Number(tick)) * 100_000_000_000;
  if (m >= 1000) return `${(m/1000).toFixed(1)}K ETH`;
  if (m >= 1)    return `${m.toFixed(1)} ETH`;
  return `${m.toFixed(4)} ETH`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function decodeInput(input) {
  try {
    const { args } = decodeFunctionData({ abi: DEPLOY_ABI, data: input });
    const lc = args[0].lockerConfig;
    return {
      rewardAdmins:     (lc.rewardAdmins     || []).map(a => a.toLowerCase()),
      rewardRecipients: (lc.rewardRecipients || []).map(a => a.toLowerCase()),
    };
  } catch { return { rewardAdmins: [], rewardRecipients: [] }; }
}

function buildMessage(eventArgs, from, txHash, inputData) {
  const a = eventArgs;
  const hook  = HOOKS[(a.poolHook  || '').toLowerCase()] || a.poolHook;
  const mev   = MEVS[(a.mevModule  || '').toLowerCase()] || a.mevModule;
  const paired = (a.pairedToken || '').toLowerCase() === WETH.toLowerCase() ? 'WETH' : a.pairedToken;
  const mcap  = tickToMcap(a.startingTick);

  let meta = {};
  let ctx  = {};
  try { meta = JSON.parse(a.tokenMetadata || '{}'); } catch {}
  try { ctx  = JSON.parse(a.tokenContext  || '{}'); } catch {}

  const { rewardAdmins, rewardRecipients } = decodeInput(inputData);

  const lines = [
    `🪙 <b>${esc(a.tokenName)} ($${esc(a.tokenSymbol)})</b>`,
    '',
    `📍 <b>Token:</b> <code>${a.tokenAddress}</code>`,
    `👤 <b>Deployer:</b> <code>${from}</code>`,
    `👑 <b>Admin:</b> <code>${a.tokenAdmin}</code>`,
  ];
  if (a.tokenImage) lines.push(`🖼️ <b>Image:</b> ${esc(a.tokenImage)}`);

  lines.push('',
    `📊 <b>Market Cap:</b> ${esc(mcap)}`,
    `🌊 <b>Hook:</b> ${esc(hook)}`,
    `💱 <b>Paired:</b> ${esc(paired)}`,
    `🛡️ <b>MEV:</b> ${esc(mev)}`,
  );

  if (rewardAdmins.length > 0) {
    lines.push('');
    rewardAdmins.forEach((a, i) =>    lines.push(`💰 <b>Reward Admin ${i+1}:</b> <code>${a}</code>`));
    rewardRecipients.forEach((r, i) => lines.push(`💰 <b>Reward Recipient ${i+1}:</b> <code>${r}</code>`));
  }

  if (Object.keys(meta).length > 0) {
    lines.push('', '📝 <b>Metadata:</b>');
    if (meta.description) lines.push(`   • ${esc(meta.description)}`);
    (meta.socialMediaUrls || []).forEach(s => lines.push(`   • <b>${esc(s.platform)}:</b> ${esc(s.url)}`));
    const known = new Set(['description','socialMediaUrls']);
    Object.entries(meta).forEach(([k,v]) => { if (!known.has(k)) lines.push(`   • <b>${esc(k)}:</b> ${esc(String(v))}`); });
  }

  if (Object.keys(ctx).length > 0) {
    lines.push('', '🏷️ <b>Context:</b>');
    Object.entries(ctx).forEach(([k,v]) => lines.push(`   • <b>${esc(k)}:</b> ${esc(String(v))}`));
  }

  lines.push('',
    `🔗 <a href="https://basescan.org/tx/${txHash}">View TX</a>  |  ` +
    `<a href="https://basescan.org/token/${a.tokenAddress}">Token</a>`
  );

  return lines.join('\n');
}

// ─── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const json = await res.json();
  if (!json.ok) console.error('Telegram error:', json.description);
  return json.ok;
}

// ─── Process a TX hash ──────────────────────────────────────────────────────
async function processTx(txHash) {
  try {
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
    if (receipt.status !== 'success') return;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== FACTORY.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: [TOKEN_CREATED_EVENT], data: log.data, topics: log.topics });
        if (d.eventName !== 'TokenCreated') continue;
        const msg = buildMessage(d.args, tx.from, txHash, tx.input);
        await sendTelegram(msg);
        console.log(`✅ Sent: ${d.args.tokenName} ($${d.args.tokenSymbol}) — ${txHash}`);
        return;
      } catch {}
    }
  } catch (e) {
    console.error(`⚠️ processTx error [${txHash}]:`, e.message);
  }
}

// ─── Startup: fetch latest deployment ──────────────────────────────────────
async function startupTest() {
  console.log('🔍 Fetching latest deployment...');
  try {
    const block = await client.getBlockNumber();
    // Scan last 10 blocks (Alchemy free limit)
    const logs = await client.getLogs({
      address: FACTORY,
      event: TOKEN_CREATED_EVENT,
      fromBlock: block - 9n,
      toBlock: block,
    });

    if (logs.length > 0) {
      const latest = logs[logs.length - 1];
      console.log(`📦 Found latest TX: ${latest.transactionHash}`);
      await sendTelegram(`🤖 <b>lqmoni bot started!</b>\nSending latest Liquid deployment as smoke test...`);
      await processTx(latest.transactionHash);
    } else {
      await sendTelegram(`🤖 <b>lqmoni bot started!</b>\nNo new deployments in last 10 blocks. Watching for new ones...`);
      console.log('No recent deployments found in last 10 blocks.');
    }
  } catch (e) {
    console.error('Startup test error:', e.message);
    await sendTelegram(`🤖 <b>lqmoni bot started!</b>\nWatching for new Liquid Protocol deployments...`);
  }
}

// ─── Express server ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // for signature verification
}));

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', bot: 'lqmoni' }));

// Alchemy webhook endpoint
app.post('/webhook', async (req, res) => {
  // Optional: verify Alchemy signature
  if (SIGN_KEY) {
    const sig = req.headers['x-alchemy-signature'];
    const expected = createHmac('sha256', SIGN_KEY).update(req.rawBody).digest('hex');
    if (sig !== expected) {
      console.warn('⚠️  Invalid webhook signature');
      return res.status(401).json({ error: 'invalid signature' });
    }
  }

  res.json({ ok: true }); // Ack immediately

  // Process webhook payload
  try {
    const body = req.body;

    // Alchemy "Log Event" webhook format
    const logs = body?.event?.data?.block?.logs || [];
    for (const log of logs) {
      const txHash = log.transaction?.hash;
      if (!txHash) continue;
      console.log(`📨 Webhook received: ${txHash}`);
      // Use processTx which fetches full data
      processTx(txHash).catch(console.error);
    }
  } catch (e) {
    console.error('Webhook processing error:', e.message);
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('═'.repeat(50));
  console.log(`🤖 lqmoni — Liquid Protocol Monitor Bot`);
  console.log(`   Factory: ${FACTORY}`);
  console.log(`   RPC:     ${RPC_URL.replace(/\/v2\/.*/, '/v2/***')}`);
  console.log(`   Chat:    ${TG_CHAT}`);
  console.log(`   Port:    ${PORT}`);
  console.log('═'.repeat(50));
  await startupTest();
  console.log('\n⏳ Waiting for Alchemy webhooks...\n');
});
