// ---------------------------------------------------------
// Slack Interaction Handler — Cloudflare Worker
// ---------------------------------------------------------
// Handles solution button clicks from Slack messages.
//
// Flow:
//   1. User clicks a solution button in Slack
//   2. Worker triggers a GitHub Action via repository_dispatch
//   3. Updates Slack message with a link to the Actions tab
//   4. The GitHub Action (create-pr.yml) handles the rest
//
// Secrets (wrangler secret put):
//   SLACK_SIGNING_SECRET  — Slack App > Basic Information
//   GITHUB_TOKEN          — Classic PAT with repo scope
//
// Vars (wrangler.toml):
//   GITHUB_REPO           — "owner/repo" format
// ---------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();

    // --- Verify Slack signature -------------------------------------------
    const timestamp = request.headers.get("x-slack-request-timestamp");
    const signature = request.headers.get("x-slack-signature");

    if (
      !(await verifySlackSignature(
        env.SLACK_SIGNING_SECRET,
        signature,
        timestamp,
        rawBody,
      ))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }

    // --- Parse payload ----------------------------------------------------
    const params = new URLSearchParams(rawBody);
    const payload = JSON.parse(params.get("payload") || rawBody);

    if (payload.type !== "block_actions") {
      return new Response("ok", { status: 200 });
    }

    const action = payload.actions[0];
    const responseUrl = payload.response_url;
    const messageBlocks = payload.message.blocks;

    // --- Handle "Skip" button ---------------------------------------------
    if (action.value === "skip") {
      ctx.waitUntil(
        updateSlackMessage(responseUrl, messageBlocks, {
          text: "⏭️ Skipped — no PR will be created.",
        }),
      );
      return new Response("ok", { status: 200 });
    }

    // --- Parse solution context from button value -------------------------
    let context;
    try {
      context = JSON.parse(action.value);
    } catch {
      return new Response("Bad payload", { status: 400 });
    }

    const { repo, issue_number, issue_title, solution } = context;
    const targetRepo = repo || env.GITHUB_REPO;
    const user = payload.user.name;
    const actionsUrl = `https://github.com/${targetRepo}/actions`;

    // --- Trigger GitHub Action and update Slack ---------------------------
    ctx.waitUntil(
      (async () => {
        try {
          // Trigger the create-pr workflow via repository_dispatch
          const res = await fetch(
            `https://api.github.com/repos/${targetRepo}/dispatches`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "SlaHub-Worker",
              },
              body: JSON.stringify({
                event_type: "create_pr",
                client_payload: {
                  issue_number,
                  issue_title,
                  solution_title: solution.title,
                  solution_description: solution.description,
                  triggered_by: user,
                },
              }),
            },
          );

          if (!res.ok) {
            const err = await res.text();
            throw new Error(`GitHub dispatch failed: ${res.status} ${err}`);
          }

          await updateSlackMessage(responseUrl, messageBlocks, {
            text: `🚀 *@${user}* picked: *${solution.title}*\n⚙️ PR creation started — <${actionsUrl}|view progress in GitHub Actions>`,
          });
        } catch (err) {
          await updateSlackMessage(responseUrl, messageBlocks, {
            text: `❌ *@${user}* picked: *${solution.title}* — failed to trigger: ${err.message}`,
          });
        }
      })(),
    );

    return new Response("ok", { status: 200 });
  },
};

// ==========================================================================
// Update Slack message — removes buttons, appends status text
// ==========================================================================

async function updateSlackMessage(responseUrl, originalBlocks, { text }) {
  const updatedBlocks = [
    ...originalBlocks.filter(
      (b) => b.type !== "actions" && b.type !== "context",
    ),
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];

  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, blocks: updatedBlocks }),
  });
}

// ==========================================================================
// Slack signature verification (Web Crypto API)
// ==========================================================================

async function verifySlackSignature(signingSecret, signature, timestamp, body) {
  const encoder = new TextEncoder();
  const baseString = `v0:${timestamp}:${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(baseString),
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `v0=${hex}` === signature;
}
