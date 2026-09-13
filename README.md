# Meta Ads Auto Monitor

A lightweight script that checks all active Meta (Facebook/Instagram) ads every 10 minutes and automatically pauses any ad that meets a stop rule — no manual monitoring needed. Runs 100% free via GitHub Actions.

---

## Stop rules

An ad gets **paused** if **either** of these is true:

1. **No-sales rule:** spend ≥ `$2` AND sales ≤ `0`
2. **Hard spend cap:** spend > `$3.5` (regardless of sales — a safety ceiling)

Any ad that doesn't match either rule is left untouched. If a read error occurs for an ad (missing/incomplete data), it is **skipped, never paused**, and retried on the next cycle.

---

## 1) Push the code to GitHub

1. Create a new repository (e.g. `meta-ads-monitor`)
2. Make it **Public** so GitHub Actions runs unlimited and free
3. Upload all files in this folder to the repository (drag & drop the *contents* of the folder, including the hidden `.github` folder)

## 2) Add your secrets

In the repository, go to:
**Settings → Secrets and variables → Actions → New repository secret**

Add these (required):

| Secret name | Value |
|---|---|
| `META_ACCESS_TOKEN` | Your Meta System User access token |
| `AD_ACCOUNT_IDS` | Comma-separated ad account IDs, e.g. `act_123,act_456` |

Add these (optional, for Telegram reports — see section 5):

| Secret name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

⚠️ Never put the token directly in the code or in a regular file in the repo — Secrets only.

## 3) Enable the workflow

- Go to the **Actions** tab in the repository
- If prompted, click "I understand my workflows, go ahead and enable them"
- The workflow (`ads-monitor.yml`) will now run automatically every 10 minutes

## 4) Manual test run (recommended before going fully automatic)

- In the **Actions** tab, select "Meta Ads Auto Monitor"
- Click **"Run workflow"** to trigger it immediately instead of waiting 10 minutes
- Open the run and check the logs — you'll see every ad's spend, sales, and whether it was paused or left alone

## 5) Telegram reports (optional)

To get a summary message in Telegram after every cycle:

1. Open Telegram, search for **@BotFather**, send `/newbot`, follow the prompts, and copy the **bot token** it gives you
2. Start a chat with your new bot (search its username and send any message, e.g. "hi")
3. Get your **chat ID**: open this URL in your browser (replace `<TOKEN>` with your bot token):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Send your bot another message first, then reload that URL — look for `"chat":{"id":123456789,...}` and copy that number
4. Add both as GitHub Secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
5. Re-run the workflow — you'll get a message listing how many ads were checked, paused, and skipped, plus the names of any paused ads

If these two secrets are not set, the script simply skips the Telegram step — nothing breaks.

## 6) Adjusting the rules (optional)

Edit the `env:` section in `.github/workflows/ads-monitor.yml`:

- `SPEND_THRESHOLD`: spend level for the no-sales rule (default `2`)
- `MIN_SALES`: sales threshold for the no-sales rule (default `0`)
- `HARD_SPEND_CAP`: spend ceiling that pauses an ad regardless of sales (default `3.5`)

## Important notes

- Each ad is evaluated **independently** — one ad's status never affects another
- GitHub Actions' schedule can occasionally run a minute or two late; this is normal and not an issue for this kind of monitoring
- The free tier applies as long as the repository stays Public

## Possible future additions

- More advanced rules (CPA, ROAS)
- Per-account or per-campaign thresholds
