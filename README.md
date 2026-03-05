# SlaHub

AI-powered GitHub issue triage → Slack analysis → one-click PR creation.

When a new issue is opened, Claude analyzes it, proposes 2-3 solutions, and posts
them to Slack as interactive buttons (similar to Google Calendar's Yes/Maybe/No).
Clicking a solution triggers a GitHub Action that generates code changes and opens a PR.

## How It Works

```
GitHub Issue opened
  → GitHub Action (issue-analyzer) triggers
    → Claude API analyzes the issue (type, severity, 2-3 solutions)
  → Posts clean Slack message with solution buttons + "Skip"
  → Team member clicks a solution
    → Cloudflare Worker fires repository_dispatch to GitHub
    → Updates Slack with link to GitHub Actions
  → GitHub Action (create-pr) runs
    → Checks out full repo
    → Claude generates code changes with full codebase context
    → Creates branch + commits + opens PR
```

## Project Structure

```
slahub/
├── app/                              # Demo web app (the thing we file issues against)
│   ├── index.html                    #   Counter UI — open in browser to use
│   └── counter.js                    #   Counter logic — increment on button click
│
├── .github/
│   └── workflows/
│       ├── issue-analyzer.yml        #   CI: issue → Claude analysis → Slack message
│       └── create-pr.yml             #   CI: dispatched by worker → runs generate script → PR
│
├── scripts/
│   └── generate-changes.ts           #   Claude tool-use loop: explores repo, generates file changes
│
├── functions/
│   ├── slack-interaction-handler.ts  #   Cloudflare Worker: Slack button → dispatch GitHub Action
│   └── wrangler.toml                 #   Worker config — name, vars, entry point
│
├── .gitignore
└── README.md
```

### File Details

| File | Purpose |
|------|---------|
| `app/index.html` | Minimal counter app. Exists so the repo has something to file issues against (e.g. "counter doesn't reset", "add a subtract button"). |
| `app/counter.js` | JavaScript for the counter. Intentionally simple — one variable, one event listener. |
| `.github/workflows/issue-analyzer.yml` | Triggers on new issues. Sends to Claude for classification + solution proposals, posts a clean Slack message with interactive buttons. Each button carries full context (issue + solution) as JSON in its value. |
| `.github/workflows/create-pr.yml` | Triggered via `repository_dispatch` from the worker. Checks out the repo, runs `scripts/generate-changes.ts`, applies the output, and creates a branch + PR. |
| `scripts/generate-changes.ts` | Claude tool-use loop. Fetches the full issue (body, comments, images) from GitHub API, gives Claude `read_file` and `list_directory` tools to explore the repo on demand, then collects the final changes via `submit_changes`. Supports vision — images attached to the issue are sent to Claude. |
| `functions/slack-interaction-handler.ts` | Lightweight Cloudflare Worker. On button click: verifies Slack signature, fires a `repository_dispatch` event to GitHub with the solution details, and updates the Slack message with a link to the Actions tab. |
| `functions/wrangler.toml` | Cloudflare Worker config. Set `GITHUB_REPO` here. Secrets set via `wrangler secret put`. |

## Setup

There are 4 secrets/tokens needed across GitHub Actions and the Cloudflare Worker.
Follow each section below in order.

---

### 1. Get your Anthropic API Key

This lets the GitHub Actions call Claude for analysis and code generation.

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Navigate to **Settings → API Keys** (left sidebar)
4. Click **Create Key**
5. Name it something like `slahub` and click **Create**
6. Copy the key immediately — it starts with `sk-ant-...` and is only shown once

> **Where it goes:**
> - GitHub Secret: `ANTHROPIC_API_KEY`

---

### 2. Create a GitHub Personal Access Token

The Cloudflare Worker uses this to trigger `repository_dispatch` events.

We recommend using a **classic token** — it's simpler and avoids permission quirks with fine-grained tokens.

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) (Tokens classic)
2. Click **Generate new token** → **Generate new token (classic)**
3. Set:
   - **Note:** `slahub-worker`
   - **Expiration:** 90 days (or custom)
   - **Scopes:** check `repo` (full control of private repositories)
4. Click **Generate token**
5. Copy the token immediately — it starts with `ghp_...` and is only shown once

> **Where it goes:**
> - Cloudflare Worker secret: `GITHUB_TOKEN`

> **Note:** The GitHub Actions workflows use the built-in `GITHUB_TOKEN` for creating branches and PRs.
> This classic PAT is only for the Cloudflare Worker to trigger `repository_dispatch`.

---

### 3. Create a Slack App and get tokens

This creates the bot that posts messages and receives button clicks.

#### 3a. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Set:
   - **App Name:** `SlaHub`
   - **Workspace:** pick your workspace
4. Click **Create App**

#### 3b. Set bot permissions

1. In the left sidebar, click **OAuth & Permissions**
2. Scroll to **Scopes → Bot Token Scopes** and add:
   - `chat:write` — post messages to channels
   - `chat:write.public` — post to channels the bot hasn't been invited to
3. Scroll back up and click **Install to Workspace**
4. Click **Allow** on the consent screen
5. Copy the **Bot User OAuth Token** — it starts with `xoxb-...`

> **Where it goes:**
> - GitHub Secret: `SLACK_BOT_TOKEN`

#### 3c. Get the Signing Secret

1. In the left sidebar, click **Basic Information**
2. Scroll to **App Credentials**
3. Click **Show** next to **Signing Secret** and copy it

> **Where it goes:**
> - Cloudflare Worker secret: `SLACK_SIGNING_SECRET`

#### 3d. Get the Channel ID

1. Open Slack and go to the channel where you want issue notifications
2. Right-click the channel name → **View channel details** (or click the channel name at the top)
3. Scroll to the bottom — the **Channel ID** is shown there (e.g. `C0123ABC456`)

> **Where it goes:**
> - GitHub Secret: `SLACK_CHANNEL_ID`

#### 3e. Enable Interactivity (do this after deploying the Worker in step 5)

1. In your Slack App settings, click **Interactivity & Shortcuts** in the left sidebar
2. Toggle **Interactivity** to **ON**
3. Set **Request URL** to your Worker URL (e.g. `https://slahub-slack-handler.<you>.workers.dev`)
4. Click **Save Changes**

---

### 4. Add secrets to GitHub

1. Go to your repo on GitHub
2. Navigate to **Settings → Secrets and variables → Actions**
3. Click **New repository secret** for each:

| Secret name | Value | From step |
|-------------|-------|-----------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Step 1 |
| `SLACK_BOT_TOKEN` | `xoxb-...` | Step 3b |
| `SLACK_CHANNEL_ID` | `C0123ABC456` | Step 3d |

---

### 5. Deploy the Cloudflare Worker

The Worker is lightweight — it just receives Slack button clicks and triggers GitHub Actions.

```bash
# Install wrangler if you don't have it
npm install -g wrangler

# Login to Cloudflare (opens browser)
wrangler login

# Go to the functions directory
cd functions

# Edit wrangler.toml — set GITHUB_REPO to your actual "owner/repo"

# Set secrets (you'll be prompted to paste each value)
wrangler secret put SLACK_SIGNING_SECRET    # from step 3c
wrangler secret put GITHUB_TOKEN            # from step 2

# Deploy
wrangler deploy
```

Wrangler prints the Worker URL after deploying (e.g. `https://slahub-slack-handler.<you>.workers.dev`).

**Now go back to step 3e** and paste this URL as the Slack Interactivity Request URL.

> **Don't have a Cloudflare account?** Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) —
> Workers has a free tier (100k requests/day) which is more than enough.

---

### 6. Test it

1. Open an issue on the repo: _"The counter doesn't have a reset button"_
2. Watch the GitHub Action run (~15s) in the **Actions** tab
3. Check your Slack channel — you'll see the analysis with solution buttons
4. Click a solution → the message updates with a link to GitHub Actions
5. Follow the link to watch the PR creation workflow
6. Review the PR on GitHub

### Troubleshooting

| Symptom | Check |
|---------|-------|
| Action runs but no Slack message | Verify `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` are correct in GitHub Secrets |
| Slack message appears but buttons don't work | Ensure Interactivity is ON and the Request URL matches your Worker URL |
| "Invalid signature" in Worker logs | Verify `SLACK_SIGNING_SECRET` matches your Slack App's signing secret |
| Dispatch fails (404) | Check that `GITHUB_TOKEN` in the worker has `repo` scope and `GITHUB_REPO` is in `owner/repo` format |
| PR creation workflow fails | Check `ANTHROPIC_API_KEY` is valid and has credits in GitHub Secrets |

> **Tip:** Use `wrangler tail` to stream live Worker logs while debugging.

---

## Customization

- **Change the Claude model**: edit `model` in `issue-analyzer.yml` and `create-pr.yml`
- **Change the analysis prompt**: edit the `PROMPT` variable in `issue-analyzer.yml`
- **Change the code generation prompt**: edit the `PROMPT` variable in `create-pr.yml`
- **Add more issue types**: extend the JSON schema in the analysis prompt
- **Route to different channels**: add logic based on `type` or `severity` in `issue-analyzer.yml`
