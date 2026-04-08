/**
 * lqmoni — Liquid Protocol Monitor Bot
 * WebSocket real-time subscription → Telegram notifications
 * Express server just for Railway health check.
 * 
 * env: RPC_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
import express from 'express';
import { createPublicClient, webSocket, http, decodeEventLog, decodeFunctionData } from 'viem';
import { base } from 'viem/chains';

// ─── Config ─────────────────────────────────────────────────────────────────
const FACTORY  = process.env.FACTORY_ADDRESS   || '0x04F1a284168743759BE6554f607a10CEBdB77760';
const RPC_HTTP = process.env.RPC_URL           || 'https://mainnet.base.org';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const PORT     = process.env.PORT || 3000;

// ─── Filters ────────────────────────────────────────────────────────────────
// Blacklist: comma-separated token names to skip (case-insensitive)
// e.g. FILTER_NAMES=test,testing,aaa
const FILTER_NAMES = (process.env.FILTER_NAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// VIP: send matching tokens to a second channel
const VIP_CHAT      = process.env.VIP_CHAT_ID || '';
const VIP_NAMES     = (process.env.VIP_NAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const VIP_DEPLOYERS = (process.env.VIP_DEPLOYERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const VIP_ADMINS    = (process.env.VIP_ADMINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const VIP_REWARD_ADMINS = (process.env.VIP_REWARD_ADMINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// VIP image domains: trigger VIP when image URL contains these domains
// e.g. VIP_IMAGE_DOMAINS=supabase.co,cloudinary.com
const VIP_IMAGE_DOMAINS = (process.env.VIP_IMAGE_DOMAINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// VIP interfaces: trigger VIP when context.interface matches (exact, case-sensitive)
// e.g. VIP_INTERFACES=Liquid Protocol
const VIP_INTERFACES = (process.env.VIP_INTERFACES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Address labels: ADDRESS_LABELS=0xabc:proxy,0xdef:team
// Displays as: 0xabc (proxy)
const LABELS = {};
(process.env.ADDRESS_LABELS || '').split(',').forEach(pair => {
  const [addr, ...rest] = pair.trim().split(':');
  if (addr && rest.length) LABELS[addr.toLowerCase()] = rest.join(':');
});

// Convert Alchemy http url → wss url automatically
const RPC_WS = RPC_HTTP.replace('https://', 'wss://').replace('http://', 'ws://');

if (!TG_TOKEN || !TG_CHAT) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

// ─── Constants ───────────────────────────────────────────────────────────────
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

// ─── Viem clients ────────────────────────────────────────────────────────────
// HTTP for fetching TX data, WS for real-time event subscription
const httpClient = createPublicClient({ chain: base, transport: http(RPC_HTTP) });
const wsClient   = createPublicClient({ chain: base, transport: webSocket(RPC_WS) });

// ─── Helpers ─────────────────────────────────────────────────────────────────
function tickToMcap(tick) {
  const m = Math.pow(1.0001, Number(tick)) * 100_000_000_000;
  if (m >= 1000) return `${(m / 1000).toFixed(1)}K ETH`;
  if (m >= 1)    return `${m.toFixed(1)} ETH`;
  return `${m.toFixed(4)} ETH`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Format address with label if available
function label(addr) {
  const low = String(addr).toLowerCase();
  const tag = LABELS[low];
  return tag ? `<code>${addr}</code> <b>(${esc(tag)})</b>` : `<code>${addr}</code>`;
}

function decodeRewards(inputData) {
  try {
    const { args } = decodeFunctionData({ abi: DEPLOY_ABI, data: inputData });
    const lc = args[0].lockerConfig;
    return {
      admins:     (lc.rewardAdmins     || []).map(a => a.toLowerCase()),
      recipients: (lc.rewardRecipients || []).map(a => a.toLowerCase()),
    };
  } catch { return { admins: [], recipients: [] }; }
}

function pickImage(eventArgs, meta, ctx) {
  // Collect image from all possible sources, return the first valid URL found
  const candidates = [
    eventArgs.tokenImage,
    meta?.image,
    ctx?.image,
    meta?.tokenImage,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    if (c.startsWith('http')) return c;
    // Convert ipfs:// to https gateway
    if (c.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + c.slice(7);
  }
  return null;
}

function buildTelegramMessage(eventArgs, from, txHash, inputData) {
  const a = eventArgs;
  const hook   = HOOKS[(a.poolHook  || '').toLowerCase()] || a.poolHook;
  const mev    = MEVS[(a.mevModule  || '').toLowerCase()] || a.mevModule;
  const paired = (a.pairedToken || '').toLowerCase() === WETH.toLowerCase() ? 'WETH' : a.pairedToken;
  const { admins, recipients } = decodeRewards(inputData);

  let meta = {}, ctx = {};
  try { meta = JSON.parse(a.tokenMetadata || '{}'); } catch {}
  try { ctx  = JSON.parse(a.tokenContext  || '{}'); } catch {}

  const image = pickImage(a, meta, ctx);

  const lines = [
    `🪙 <b>${esc(a.tokenName)} ($${esc(a.tokenSymbol)})</b>`,
    '',
    `📍 <b>Token:</b> <code>${a.tokenAddress}</code>`,
    `👤 <b>Deployer:</b> ${label(from)}`,
    `👑 <b>Admin:</b> ${label(a.tokenAdmin)}`,
  ];
  if (image) lines.push(`🖼️ <b>Image:</b> ${esc(image)}`);
  lines.push(
    '',
    `📊 <b>Market Cap:</b> ${esc(tickToMcap(a.startingTick))}`,
    `🌊 <b>Hook:</b> ${esc(hook)}`,
    `💱 <b>Paired:</b> ${esc(paired)}`,
    `🛡️ <b>MEV:</b> ${esc(mev)}`,
  );

  if (admins.length > 0) {
    lines.push('');
    admins.forEach((addr, i) =>     lines.push(`💰 <b>Reward Admin ${i+1}:</b> ${label(addr)}`));
    recipients.forEach((addr, i) => lines.push(`💰 <b>Reward Recipient ${i+1}:</b> ${label(addr)}`));
  }

  if (Object.keys(meta).length > 0) {
    lines.push('', '📝 <b>Metadata:</b>');
    if (meta.description) lines.push(`   • ${esc(meta.description)}`);
    (meta.socialMediaUrls || []).forEach(s => lines.push(`   • <b>${esc(s.platform)}:</b> ${esc(s.url)}`));
    // Show other meta fields except image (already shown above)
    const known = new Set(['description', 'socialMediaUrls', 'image', 'tokenImage']);
    Object.entries(meta).forEach(([k, v]) => { if (!known.has(k)) lines.push(`   • <b>${esc(k)}:</b> ${esc(String(v))}`); });
  }

  if (Object.keys(ctx).length > 0) {
    lines.push('', '🏷️ <b>Context:</b>');
    // Show all context except image (already shown above)
    Object.entries(ctx).forEach(([k, v]) => {
      if (k !== 'image') lines.push(`   • <b>${esc(k)}:</b> ${esc(String(v))}`);
    });
  }

  lines.push('',
    `🔗 <a href="https://basescan.org/tx/${txHash}">View TX</a>  |  ` +
    `<a href="https://basescan.org/token/${a.tokenAddress}">Token</a>`
  );

  return { text: lines.join('\n'), image };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(text, imageUrl = null, chatId = TG_CHAT) {
  try {
    // Try sendPhoto if image URL available
    if (imageUrl) {
      const photoRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, photo: imageUrl, caption: text, parse_mode: 'HTML' }),
      });
      const photoJson = await photoRes.json();
      if (photoJson.ok) return; // success
      console.warn('sendPhoto failed, falling back to text:', photoJson.description);
    }
    // Fallback: send as text message
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const json = await res.json();
    if (!json.ok) console.error('Telegram error:', json.description);
  } catch (e) { console.error('Telegram fetch error:', e.message); }
}

// ─── Process a TX ─────────────────────────────────────────────────────────────
const processed = new Set();
async function processTx(txHash) {
  if (processed.has(txHash)) return;
  processed.add(txHash);
  try {
    const [tx, receipt] = await Promise.all([
      httpClient.getTransaction({ hash: txHash }),
      httpClient.getTransactionReceipt({ hash: txHash }),
    ]);
    if (receipt.status !== 'success') return;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== FACTORY.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: [TOKEN_CREATED_EVENT], data: log.data, topics: log.topics });
        if (d.eventName !== 'TokenCreated') continue;

        const tokenName   = d.args.tokenName  || '';
        const tokenSymbol = d.args.tokenSymbol || '';
        const deployer    = tx.from.toLowerCase();
        const admin       = (d.args.tokenAdmin || '').toLowerCase();

        // Decode rewards for VIP check
        const { admins: rewardAdmins } = decodeRewards(tx.input);

        // === Blacklist: skip tokens with filtered names ===
        const nameLower = tokenName.toLowerCase();
        const symbolLower = tokenSymbol.toLowerCase();
        if (FILTER_NAMES.some(f => nameLower === f || symbolLower === f)) {
          console.log(`⏭️  Filtered: ${tokenName} ($${tokenSymbol}) — blacklisted name`);
          return;
        }

        console.log(`✅ ${tokenName} ($${tokenSymbol}) — ${txHash}`);
        const { text, image } = buildTelegramMessage(d.args, tx.from, txHash, tx.input);

        // Send to main channel
        await sendTelegram(text, image, TG_CHAT);

        // === VIP: check if should also send to second channel ===
        if (VIP_CHAT) {
          // Parse context for interface check
          let ctx = {};
          try { ctx = JSON.parse(d.args.tokenContext || '{}'); } catch {}
          const ctxInterface = ctx.interface || '';

          // Check image domain
          const tokenImage = d.args.tokenImage || '';
          const imageMatchesVip = VIP_IMAGE_DOMAINS.some(dom => tokenImage.toLowerCase().includes(dom));

          // Check interface
          const interfaceMatchesVip = VIP_INTERFACES.some(vi => ctxInterface === vi);

          const isVip =
            VIP_NAMES.some(n => nameLower.includes(n) || symbolLower.includes(n)) ||
            VIP_DEPLOYERS.includes(deployer) ||
            VIP_ADMINS.includes(admin) ||
            VIP_REWARD_ADMINS.some(va => rewardAdmins.includes(va)) ||
            imageMatchesVip ||
            interfaceMatchesVip;

          if (isVip) {
            await sendTelegram('⭐ VIP\n\n' + text, image, VIP_CHAT);
            console.log(`  ⭐ Also sent to VIP channel`);
          }
        }
        return;
      } catch {}
    }
  } catch (e) { console.error(`⚠️ Error [${txHash}]:`, e.message); }
}

// ─── Startup smoke test: send latest deployment ───────────────────────────────
async function sendLatestDeployment() {
  console.log('🔍 Fetching latest deployment for smoke test...');
  try {
    const block = await httpClient.getBlockNumber();
    // Alchemy free: max 10 blocks per getLogs
    const logs = await httpClient.getLogs({
      address: FACTORY,
      event: TOKEN_CREATED_EVENT,
      fromBlock: block - 9n,
      toBlock: block,
    });
    if (logs.length > 0) {
      const txHash = logs[logs.length - 1].transactionHash;
      console.log(`📦 Latest TX: ${txHash}`);
      await sendTelegram(`🤖 <b>lqmoni started!</b>\nSending latest deployment as smoke test...`);
      await processTx(txHash);
    } else {
      await sendTelegram(`🤖 <b>lqmoni started!</b>\nNo deployments in last 10 blocks. Watching via WebSocket...`);
    }
  } catch (e) {
    console.warn('Smoke test skipped:', e.message);
    await sendTelegram(`🤖 <b>lqmoni started!</b>\nWatching for new Liquid Protocol deployments...`);
  }
}

// ─── WebSocket real-time subscription ────────────────────────────────────────
function startWebSocket() {
  console.log(`🔌 WebSocket: ${RPC_WS.replace(/\/v2\/.*/, '/v2/***')}`);
  wsClient.watchEvent({
    address: FACTORY,
    event: TOKEN_CREATED_EVENT,
    onLogs: (logs) => {
      for (const log of logs) {
        console.log(`📨 New event: ${log.transactionHash}`);
        processTx(log.transactionHash).catch(console.error);
      }
    },
    onError: (err) => console.error('WS error:', err.message),
  });
  console.log('⚡ WebSocket subscribed — real-time monitoring active\n');
}

// ─── Express health check (required for Railway) ──────────────────────────────
const app = express();
app.get('/', (_, res) => res.json({ status: 'ok', bot: 'lqmoni', uptime: process.uptime() }));
app.listen(PORT, async () => {
  console.log('══════════════════════════════════════════════════');
  console.log('🤖 lqmoni — Liquid Protocol Monitor Bot');
  console.log(`   Factory : ${FACTORY}`);
  console.log(`   RPC     : ${RPC_HTTP.replace(/\/v2\/.*/, '/v2/***')}`);
  console.log(`   Chat ID : ${TG_CHAT}`);
  console.log(`   Port    : ${PORT}`);
  console.log('══════════════════════════════════════════════════');

  await sendLatestDeployment(); // smoke test
  startWebSocket();             // real-time
});
