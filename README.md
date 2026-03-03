# Notion Document Comment Plugin for OpenClaw

Monitor Notion page comments and auto-reply with AI.

## What this plugin does

- Polls Notion comments (page-level + inline comments)
- Groups by discussion thread and replies in-thread
- Supports **index page** mode (auto-discover linked pages)
- Stores processed comment IDs in `state.json` to avoid duplicate replies

## Security/architecture updates (v0.2.0)

Compared to the original version:

1. Supports **env-based secrets** (`*_Env`) to avoid plain-text keys in `config.json`
2. Supports `plugins.entries.<id>.config` (preferred) in `openclaw.json`
3. Defaults to local **OpenClaw Gateway** `/v1/chat/completions`
4. Can fallback to external AI API (`aiBaseUrl + aiApiKey/aiApiKeyEnv`)

---

## Prerequisites

- OpenClaw `v2026.1.x+`
- A Notion Integration with capabilities:
  - Read content
  - Read comments
  - Insert comments

## Installation

```bash
cd ~/.openclaw/extensions
git clone https://github.com/ClarkYoung-xhs/openclaw-notion-comment.git notion-doc-comment
cd notion-doc-comment
npm install
```

## Notion setup

For each page you want to monitor:

1. Open the page
2. `...` → **Connect to** → select your integration

---

## Configuration (recommended)

### 1) Plugin entry in `~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "entries": {
      "notion-doc-comment": {
        "enabled": true,
        "path": "~/.openclaw/extensions/notion-doc-comment",
        "config": {
          "pollIntervalMinutes": 15,
          "indexPage": "",
          "watchedPages": ["page-id-1", "page-id-2"],
          "integrationUserId": "",

          "notionApiKeyEnv": "NOTION_API_KEY",

          "useGatewayChatCompletions": true,
          "gatewayBaseUrl": "http://127.0.0.1:18789/v1",
          "gatewayApiKeyEnv": "OPENCLAW_GATEWAY_TOKEN",

          "aiBaseUrl": "https://right.codes/codex/v1",
          "aiApiKeyEnv": "RIGHTCODE_API_KEY",
          "aiModel": "openclaw:friday"
        }
      }
    }
  }
}
```

### 2) Environment variables (recommended)

```bash
export NOTION_API_KEY='secret_xxx'
export OPENCLAW_GATEWAY_TOKEN='your_gateway_token'
# optional fallback only
export RIGHTCODE_API_KEY='your_external_ai_key'
```

> Tip: in production, set these in your service manager (systemd/docker env), not shell profile.

---

## Legacy config (`config.json`) still supported

You can still use `config.json` inside plugin directory.

Config priority:

1. `plugins.entries.notion-doc-comment.config` (highest)
2. `config.json` (legacy)

`config.example.json` is updated and now env-first.

---

## Key fields

- `pollIntervalMinutes`: Poll interval in minutes
- `indexPage`: Index page ID for link-based discovery
- `watchedPages`: Explicit page IDs (used if index page yields none)
- `integrationUserId`: Avoid self-reply loops
- `notionApiKey` / `notionApiKeyEnv`: Notion token source
- `useGatewayChatCompletions`: use local OpenClaw gateway first (default `true`)
- `gatewayBaseUrl`: default `http://127.0.0.1:18789/v1`
- `gatewayApiKey` / `gatewayApiKeyEnv`: optional gateway bearer token
- `aiBaseUrl`: external fallback base URL
- `aiApiKey` / `aiApiKeyEnv`: external fallback API key
- `aiModel`:
  - Gateway mode: can use `openclaw:<agentId>` (e.g. `openclaw:friday`)
  - External mode: use provider model name
- `systemPrompt`: optional system prompt override

---

## Notes

- If gateway `/v1/chat/completions` is unavailable and no external key is provided, plugin returns a temporary failure message.
- `state.json` and `config.json` are ignored by git.

## License

MIT
