# lqmoni — Liquid Protocol Monitor Bot

Real-time Telegram notifications for [Liquid Protocol](https://liquidprotocol.xyz) token deployments on Base.

**Single file. No bloat.**

## Setup

### 1. Railway + GitHub
Push this folder to GitHub → connect to Railway → set env vars.

### 2. Environment Variables (Railway dashboard)

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | ✅ | Alchemy: `https://base-mainnet.g.alchemy.com/v2/KEY` |
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Your channel ID e.g. `-1001234567890` |
| `ALCHEMY_SIGNING_KEY` | optional | Verify webhook signatures |

### 3. Alchemy Webhook Setup

1. Go to [Alchemy Dashboard](https://dashboard.alchemy.com/) → **Notify** → **Create Webhook**
2. Type: **GraphQL**
3. Network: **Base Mainnet**
4. Webhook URL: `https://your-railway-app.railway.app/webhook`
5. GraphQL query:
```graphql
{
  block {
    logs(filter: {
      addresses: ["0x04F1a284168743759BE6554f607a10CEBdB77760"],
      topics: ["0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67"]
    }) {
      data
      topics
      transaction { hash }
      account { address }
    }
  }
}
```
6. Copy the **Signing Key** → set as `ALCHEMY_SIGNING_KEY` in Railway

> The topic hash `0x9299d...` is the keccak256 of the `TokenCreated` event signature.

## How it works

- **On startup**: fetches the latest Liquid deployment → sends to Telegram (smoke test)
- **Real-time**: Alchemy calls `POST /webhook` whenever a new token is deployed → instant Telegram notification
- **Health check**: `GET /` returns `{"status":"ok"}`
