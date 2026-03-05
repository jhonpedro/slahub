// ---------------------------------------------------------
// Slack Interaction Handler — Cloudflare Worker
// ---------------------------------------------------------
// Handles solution button clicks from Slack messages.
//
// Flow:
//   1. User clicks a solution button in Slack
//   2. Worker acknowledges immediately (Slack 3s timeout)
//   3. Calls Claude to generate code changes for the solution
//   4. Creates a branch + commits + opens a PR on GitHub
//   5. Updates the Slack message with the PR link
//
// Secrets (wrangler secret put):
//   SLACK_SIGNING_SECRET  — Slack App > Basic Information
//   GITHUB_TOKEN          — PAT with repo scope
//   ANTHROPIC_API_KEY     — Claude API key
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

    // --- Handle "Skip" button ---------------------------------------------
    if (action.value === "skip") {
      await updateSlackMessage(payload.response_url, payload.message.blocks, {
        text: "⏭️ Skipped — no PR will be created.",
      });
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
    const user = payload.user.name;

    // --- Respond immediately, do heavy work in background -----------------
    // Slack requires a response within 3 seconds. We acknowledge now and
    // use waitUntil to do the Claude + GitHub work asynchronously.
    const responseUrl = payload.response_url;
    const messageBlocks = payload.message.blocks;

    // Update Slack to show "working on it"
    ctx.waitUntil(
      (async () => {
        await updateSlackMessage(responseUrl, messageBlocks, {
          text: `⏳ *@${user}* picked: *${solution.title}* — creating PR...`,
        });

        try {
          const pr = await createPR(env, {
            repo: repo || env.GITHUB_REPO,
            issueNumber: issue_number,
            issueTitle: issue_title,
            solution,
            user,
          });

          await updateSlackMessage(responseUrl, messageBlocks, {
            text: `✅ *@${user}* picked: *${solution.title}*\n📎 PR created: <${pr.html_url}|#${pr.number} ${pr.title}>`,
          });
        } catch (err) {
          await updateSlackMessage(responseUrl, messageBlocks, {
            text: `❌ *@${user}* picked: *${solution.title}* — PR creation failed: ${err.message}`,
          });
        }
      })(),
    );

    return new Response("ok", { status: 200 });
  },
};

// ==========================================================================
// Create PR: Claude generates code → GitHub branch + commit + PR
// ==========================================================================

async function createPR(env, { repo, issueNumber, issueTitle, solution, user }) {
  const gh = githubAPI(env.GITHUB_TOKEN, repo);

  // 1. Get the default branch and its latest SHA
  const repoInfo = await gh("GET", "");
  const defaultBranch = repoInfo.default_branch;

  const ref = await gh("GET", `git/ref/heads/${defaultBranch}`);
  const baseSha = ref.object.sha;

  // 2. Get the repo file tree so Claude knows what files exist
  const tree = await gh("GET", `git/trees/${baseSha}?recursive=1`);
  const filePaths = tree.tree
    .filter((f) => f.type === "blob")
    .map((f) => f.path);

  // 3. Read key files so Claude can generate meaningful changes
  //    (limit to small text files to stay within token budget)
  const filesToRead = filePaths
    .filter(
      (f) =>
        f.match(/\.(js|ts|html|css|json|yml|yaml|md)$/) &&
        !f.includes("node_modules") &&
        !f.includes("package-lock"),
    )
    .slice(0, 20);

  const fileContents = await Promise.all(
    filesToRead.map(async (path) => {
      try {
        const file = await gh("GET", `contents/${path}?ref=${defaultBranch}`);
        const content = atob(file.content);
        // Skip files that are too large
        if (content.length > 10000) return null;
        return { path, content };
      } catch {
        return null;
      }
    }),
  );

  const validFiles = fileContents.filter(Boolean);
  const codeContext = validFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  // 4. Ask Claude to generate the code changes
  const changes = await callClaude(env.ANTHROPIC_API_KEY, {
    issueTitle,
    issueNumber,
    solution,
    codeContext,
    filePaths,
  });

  if (!changes.files || changes.files.length === 0) {
    throw new Error("Claude returned no file changes");
  }

  // 5. Create a new branch
  const branchName = `slahub/issue-${issueNumber}-${slugify(solution.title)}`;

  await gh("POST", "git/refs", {
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // 6. Commit each file change
  for (const file of changes.files) {
    // Get existing file SHA if updating (needed by the API)
    let existingSha;
    try {
      const existing = await gh(
        "GET",
        `contents/${file.path}?ref=${branchName}`,
      );
      existingSha = existing.sha;
    } catch {
      // New file, no SHA needed
    }

    await gh("PUT", `contents/${file.path}`, {
      message: `${file.action === "create" ? "Add" : "Update"} ${file.path}\n\nPart of solution: ${solution.title}\nCloses #${issueNumber}`,
      content: btoa(unescape(encodeURIComponent(file.content))),
      branch: branchName,
      ...(existingSha && { sha: existingSha }),
    });
  }

  // 7. Open the PR
  const pr = await gh("POST", "pulls", {
    title: `fix: ${solution.title} (#${issueNumber})`,
    body: [
      `## Summary`,
      ``,
      solution.description,
      ``,
      `## Changes`,
      ``,
      ...changes.files.map(
        (f) => `- **${f.action}** \`${f.path}\` — ${f.reason}`,
      ),
      ``,
      `---`,
      `Closes #${issueNumber}`,
      `Selected by @${user} via Slack`,
      `_Generated by SlaHub_`,
    ].join("\n"),
    head: branchName,
    base: defaultBranch,
  });

  return pr;
}

// ==========================================================================
// Call Claude to generate file changes for a solution
// ==========================================================================

async function callClaude(apiKey, { issueTitle, issueNumber, solution, codeContext, filePaths }) {
  const prompt = `You are a senior software engineer. Generate code changes to implement the following solution for a GitHub issue.

Issue #${issueNumber}: ${issueTitle}
Solution: ${solution.title}
Description: ${solution.description}

Here are the files in the repository:
${filePaths.join("\n")}

Here is the content of relevant files:
${codeContext}

Respond with ONLY valid JSON (no markdown fences):
{
  "files": [
    {
      "path": "path/to/file.js",
      "action": "update" | "create",
      "reason": "short explanation of the change",
      "content": "full file content after changes"
    }
  ]
}

Rules:
- Return the COMPLETE file content for each changed file (not a diff).
- Only include files that need changes.
- Keep changes minimal and focused on the solution.
- Do not change unrelated code.
- If creating a new file, use "create" as the action.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text;

  if (!text) {
    throw new Error("Empty response from Claude");
  }

  return JSON.parse(text);
}

// ==========================================================================
// GitHub API helper
// ==========================================================================

function githubAPI(token, repo) {
  return async (method, endpoint, body) => {
    const url = `https://api.github.com/repos/${repo}/${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "SlaHub-Worker",
      },
      ...(body && { body: JSON.stringify(body) }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GitHub API ${method} ${endpoint}: ${res.status} ${err}`);
    }

    return res.json();
  };
}

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

// ==========================================================================
// Utility
// ==========================================================================

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}
