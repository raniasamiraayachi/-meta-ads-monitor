# Meta Ads Auto Monitor

A lightweight script that checks all active Meta (Facebook/Instagram) ads every 10 minutes and automatically pauses any ad that meets a stop rule — no manual monitoring needed. Runs 100% free via GitHub Actions.

---

## Stop rules

An ad gets **paused** if **either** of these is true:

1. **No-sales rule:** spend ≥ `$2` AND sales ≤ `0`
2. **Hard spend cap:** spend > `$3.5` (regardless of sales — a safety ceiling)

Any ad that doesn't match either rule is left untouched. If a read error occurs for an ad (missing/incomplete data), it is **skipped, never paused**, and retried on the next cycle.

---

## What happens when an ad hits the hard cap

Hitting the hard cap (`spend > $3.5`) doesn't always mean "pause and forget". Three things can happen, checked in this order:

1. **Already used its 2nd chance** — if this exact ad is itself a duplicate created by rule 2 below, it's just paused. No further duplicating (avoids an infinite loop).
2. **Proven "winning" ad** — if the ad's **lifetime** stats show more than 3 sales at an average cost below $3, it's paused but scheduled to **restart automatically at 00:00 Algeria time**, giving it a fresh day. If this pause‑then‑restart happens **3 days in a row**, the ad is **permanently blacklisted**: paused for good and never checked or touched again.
3. **Got a sale today, but not (yet) a proven winner** — if the ad has ≥1 sale today and hits the cap, it's paused and **duplicated** (identical budget/targeting/creative) for one extra shot. If that duplicate also hits the cap with a sale, see rule 1 — it's just paused, no third clone.
4. **No sales, not a winner** — paused normally, same as the base hard-cap rule.

This needs to remember things between runs (which ads already got their 2nd chance, streak counts, which ads are blacklisted, which winners are waiting for their midnight restart). That state lives in `state.json` at the repo root, and the workflow commits it back to the repo after every run and after every midnight restart.

A second workflow, `restart-winners.yml`, runs once a day at 00:00 Algeria time (`23:00 UTC` — Algeria has no daylight saving) and reactivates any ad queued up by rule 2.

Extra tunables (optional, in `ads-monitor.yml`'s `env:`):

| Env var | Meaning | Default |
| --- | --- | --- |
| `WINNER_MIN_SALES` | Lifetime sales must be **more than** this to count as a "winner" | `3` |
| `WINNER_MAX_AVG_COST` | Lifetime average cost/sale must be **below** this | `3` |
| `WINNER_STREAK_LIMIT` | Consecutive cap-hit days before permanent blacklist | `3` |

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

- Each ad's *stop rule* is evaluated independently — but the 2nd-chance duplicate, the winner streak count, and the blacklist are persisted in `state.json` and carried across runs and across days
- GitHub Actions' schedule can occasionally run a minute or two late; this is normal and not an issue for this kind of monitoring
- The free tier applies as long as the repository stays Public
- To un-blacklist an ad or reset a streak, edit `state.json` directly (remove its entry from `blacklist` or `winnerStreaks`) and commit the change

## Possible future additions

- More advanced rules (CPA, ROAS)
- Per-account or per-campaign thresholds
