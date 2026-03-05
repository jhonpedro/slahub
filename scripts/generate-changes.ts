// ---------------------------------------------------------
// Generate Changes with Claude (Tool Use)
// ---------------------------------------------------------
// Called by the create-pr GitHub Action. Uses Claude's tool_use
// to let it explore the repo on demand — reads only the files
// it needs, works on any repo size.
//
// Env vars (set by the workflow):
//   ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_REPO,
//   ISSUE_NUMBER, SOLUTION_TITLE, SOLUTION_DESC, FILE_TREE
//
// Output: writes /tmp/changes.json with the file changes.
// ---------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

// ==========================================================================
// Types
// ==========================================================================

interface FileChange {
  path: string;
  action: "update" | "create";
  reason: string;
  content: string;
}

interface SubmitChangesInput {
  files: FileChange[];
}

interface ToolInput {
  path?: string;
  files?: FileChange[];
}

interface GitHubIssue {
  title: string;
  body: string | null;
  labels: { name: string }[];
}

interface GitHubComment {
  user: { login: string };
  body: string;
}

interface ContentBlock {
  type: "text" | "tool_use";
  id?: string;
  name?: string;
  input?: ToolInput;
  text?: string;
}

interface ClaudeResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use";
  error?: { message: string };
}

type MessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "url"; url: string } }
      | { type: "tool_result"; tool_use_id: string; content: string }
    >;

interface Message {
  role: "user" | "assistant";
  content: MessageContent;
}

// ==========================================================================
// Env
// ==========================================================================

const API_KEY = process.env.ANTHROPIC_API_KEY!;
const GH_TOKEN = process.env.GITHUB_TOKEN!;
const GH_REPO = process.env.GITHUB_REPO!;
const ISSUE_NUMBER = process.env.ISSUE_NUMBER!;
const SOLUTION_TITLE = process.env.SOLUTION_TITLE!;
const SOLUTION_DESC = process.env.SOLUTION_DESC!;
const FILE_TREE = process.env.FILE_TREE!;

const MAX_TURNS = 30;

// ==========================================================================
// Tools available to Claude
// ==========================================================================

const tools = [
  {
    name: "read_file",
    description:
      "Read the contents of a file in the repository. Use this to explore the codebase and understand existing code before making changes.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description:
            "Relative file path from repo root (e.g. 'app/counter.js')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List files and subdirectories in a directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description:
            "Relative directory path from repo root (e.g. 'app' or '.')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "submit_changes",
    description:
      "Submit the final file changes to be applied as a PR. Call this once you have all the changes ready.",
    input_schema: {
      type: "object" as const,
      properties: {
        files: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              path: {
                type: "string" as const,
                description: "File path relative to repo root",
              },
              action: {
                type: "string" as const,
                enum: ["update", "create"],
                description:
                  "Whether updating an existing file or creating a new one",
              },
              reason: {
                type: "string" as const,
                description: "Short explanation of the change",
              },
              content: {
                type: "string" as const,
                description: "Complete file content after changes",
              },
            },
            required: ["path", "action", "reason", "content"],
          },
        },
      },
      required: ["files"],
    },
  },
];

// ==========================================================================
// Tool handlers
// ==========================================================================

function handleToolCall(name: string, input: ToolInput): string {
  if (name === "read_file") {
    const filePath = path.resolve(input.path!);
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return `Error: file not found — ${input.path}`;
    }
  }
  if (name === "list_directory") {
    const dirPath = path.resolve(input.path!);
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    } catch {
      return `Error: directory not found — ${input.path}`;
    }
  }
  if (name === "submit_changes") {
    return JSON.stringify(input as SubmitChangesInput);
  }
  return "Unknown tool";
}

// ==========================================================================
// Claude API
// ==========================================================================

async function callClaude(messages: Message[]): Promise<ClaudeResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      tools,
      messages,
    }),
  });
  return res.json() as Promise<ClaudeResponse>;
}

// ==========================================================================
// GitHub: fetch full issue + comments
// ==========================================================================

async function fetchIssue(): Promise<{
  issue: GitHubIssue;
  comments: GitHubComment[];
}> {
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "SlaHub",
  };

  const [issueRes, commentsRes] = await Promise.all([
    fetch(
      `https://api.github.com/repos/${GH_REPO}/issues/${ISSUE_NUMBER}`,
      { headers },
    ),
    fetch(
      `https://api.github.com/repos/${GH_REPO}/issues/${ISSUE_NUMBER}/comments`,
      { headers },
    ),
  ]);

  const issue = (await issueRes.json()) as GitHubIssue;
  const comments = (await commentsRes.json()) as GitHubComment[];

  return { issue, comments };
}

// ==========================================================================
// Image extraction from markdown
// ==========================================================================

function extractImageUrls(text: string | null): string[] {
  if (!text) return [];
  const urls: string[] = [];
  let match: RegExpExecArray | null;

  // Markdown image syntax: ![alt](url)
  const mdRegex =
    /!\[.*?\]\((https:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp|svg)[^\s)]*)\)/gi;
  while ((match = mdRegex.exec(text)) !== null) {
    urls.push(match[1]);
  }

  // Bare GitHub user-content image URLs
  const bareRegex =
    /(https:\/\/github\.com\/user-attachments\/[^\s)]+)/gi;
  while ((match = bareRegex.exec(text)) !== null) {
    if (!urls.includes(match[1])) urls.push(match[1]);
  }

  return urls;
}

// Build Claude message content with text + images (vision)
function buildUserContent(
  textPrompt: string,
  imageUrls: string[],
): MessageContent {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "url"; url: string } }
  > = [{ type: "text", text: textPrompt }];

  for (const url of imageUrls) {
    content.push({
      type: "image",
      source: { type: "url", url },
    });
  }

  return content;
}

// ==========================================================================
// Main loop
// ==========================================================================

async function main(): Promise<void> {
  console.log(`Fetching issue #${ISSUE_NUMBER}...`);
  const { issue, comments } = await fetchIssue();

  const issueTitle = issue.title;
  const issueBody = issue.body || "(no description)";
  const issueLabels = (issue.labels || []).map((l) => l.name).join(", ");

  // Collect all text from issue + comments
  let fullContext = `## Issue Body\n\n${issueBody}`;
  if (comments.length > 0) {
    fullContext += "\n\n## Comments\n\n";
    for (const c of comments) {
      fullContext += `**@${c.user.login}:**\n${c.body}\n\n`;
    }
  }

  // Extract images from issue body + comments for Claude vision
  const imageUrls = [
    ...extractImageUrls(issueBody),
    ...comments.flatMap((c) => extractImageUrls(c.body)),
  ];

  if (imageUrls.length > 0) {
    console.log(
      `Found ${imageUrls.length} image(s) in issue — sending to Claude as vision.`,
    );
  }

  const textPrompt = `You are a senior software engineer implementing a solution for a GitHub issue.

Issue #${ISSUE_NUMBER}: ${issueTitle}
Labels: ${issueLabels || "none"}
Solution: ${SOLUTION_TITLE}
Description: ${SOLUTION_DESC}

${fullContext}

Repository file tree:
${FILE_TREE}

Instructions:
1. Use read_file to explore the relevant files in the repo.
2. Understand the existing code structure and patterns.
3. If images are attached above, examine them — they may contain screenshots, error logs, or UI mockups relevant to the issue.
4. When you have a clear plan, use submit_changes with all file modifications.
5. Return COMPLETE file contents for each changed file (not diffs).
6. Keep changes minimal and focused on the solution.
7. Do not change unrelated code.`;

  const userContent = buildUserContent(textPrompt, imageUrls);

  const messages: Message[] = [{ role: "user", content: userContent }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`Turn ${turn + 1}...`);
    const response = await callClaude(messages);

    if (response.error) {
      console.error("API error:", JSON.stringify(response.error));
      process.exit(1);
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content as any });

      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
      }> = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`  → ${block.name}(${JSON.stringify(block.input)})`);
          const result = handleToolCall(block.name!, block.input!);

          if (block.name === "submit_changes") {
            console.log("Changes submitted.");
            fs.writeFileSync("/tmp/changes.json", result);
            process.exit(0);
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id!,
            content: result,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    } else {
      const textBlock = response.content.find((b) => b.type === "text");
      if (textBlock) {
        console.log("Claude responded with text (no tool call). Ending.");
        console.log(textBlock.text!.slice(0, 200));
      }
      console.error("Claude ended without calling submit_changes.");
      process.exit(1);
    }
  }

  console.error("Max turns reached without submit_changes.");
  process.exit(1);
}

main();
