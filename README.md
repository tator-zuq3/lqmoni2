# lqmoni — Liquid Protocol Monitor Bot

Real-time Telegram notifications for [Liquid Protocol](https://liquidprotocol.xyz) token deployments on Base.

**Single file. WebSocket real-time. No webhook setup needed.**

## How it works

1. **On startup** → fetches latest deployment → sends to Telegram (smoke test)
2. **Real-time** → WebSocket subscription to Alchemy → instant notification when new token deployed

## Railway Variables

| Variable | Required | Value |
|---|---|---|
| `RPC_URL` | ✅ | `https://base-mainnet.g.alchemy.com/v2/YOUR_KEY` |
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Your channel/group ID |

> The bot auto-converts your `https://` RPC URL to `wss://` for WebSocket.  
> No Alchemy Notify setup needed.
