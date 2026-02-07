# Notion Document Comment Plugin for OpenClaw

Monitor Notion page comments and respond automatically via AI agent.

## Features

- 🔄 **Polling**: Periodically checks for new comments on watched pages
- 🤖 **AI Reply**: Generates intelligent responses via OpenClaw agent
- 📑 **Index Page Pattern**: A main page links to all pages to monitor
- 💬 **Thread-Aware**: Groups comments by discussion thread, replies in context
- 💾 **State Persistence**: Tracks processed comments to avoid duplicates

## Architecture

```
Notion Pages → [Polling] → New Comments? → [Agent] → AI Reply → [Notion API] → Reply Posted
      ↑                                                                              
Index Page (optional) — contains links to pages to monitor
```

## Prerequisites

- [OpenClaw](https://github.com/nicepkg/openclaw) v2026.1.x+
- A Notion Integration ([create one here](https://www.notion.so/profile/integrations))

## Installation

### 1. Clone the plugin

```bash
cd ~/.openclaw/extensions
git clone https://github.com/ClarkYoung-xhs/openclaw-notion-doc-comment.git notion-doc-comment
cd notion-doc-comment
npm install
```

### 2. Create a Notion Integration

1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
2. Click **New integration**
3. Select your workspace
4. Enable capabilities:
   - ✅ Read content
   - ✅ Read comments
   - ✅ Insert comments
5. Copy the **Internal Integration Secret** (`secret_xxx`)

### 3. Connect to pages

For each page you want to monitor:
1. Open the page in Notion
2. Click `...` → **Connect to** → Select your integration

### 4. Configure the plugin

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
    "notionApiKey": "secret_your_token_here",
    "pollIntervalMinutes": 15,
    "indexPage": "",
    "watchedPages": ["page-id-1", "page-id-2"],
    "integrationUserId": ""
}
```

| Field | Description |
|-------|-------------|
| `notionApiKey` | Your Notion integration secret |
| `pollIntervalMinutes` | How often to check for new comments (default: 15) |
| `indexPage` | ID of a page whose child pages/links are auto-watched |
| `watchedPages` | Explicit list of page IDs to monitor |
| `integrationUserId` | Your integration's user ID (prevents self-reply loops) |

> **Tip**: Use `indexPage` for easy management — just add/remove links in one page.

### 5. Register in OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
    "plugins": {
        "entries": {
            "notion-doc-comment": {
                "enabled": true,
                "path": "~/.openclaw/extensions/notion-doc-comment"
            }
        }
    }
}
```

Restart OpenClaw:

```bash
systemctl --user restart openclaw-gateway
```

## How It Works

1. **Startup**: Plugin initializes, reads config, creates Notion client
2. **Index Page** (optional): Reads the index page, extracts all linked page IDs
3. **Polling Loop**: Every N minutes:
   - Fetches all comments for each watched page
   - Groups comments by discussion thread
   - Finds new/unprocessed comments
   - Sends comment text to AI agent
   - Posts AI reply in the same discussion thread
4. **State**: Saves processed comment IDs to `state.json` to avoid duplicates

## Finding Page IDs

A Notion page URL like:
```
https://www.notion.so/My-Page-Title-abc123def456789012345678abcdef01
```

The page ID is the last 32 hex characters: `abc123def456789012345678abcdef01`

Or in UUID format: `abc123de-f456-7890-1234-5678abcdef01`

## License

MIT
