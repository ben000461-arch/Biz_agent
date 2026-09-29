// friend-agent — Telegram-to-GitHub coding agent bridge
//
// What this does, end to end:
//   1. Friend messages a Telegram bot with a loose task description
//   2. This server cleans that text into a well-formed GitHub issue (title + body)
//      using an LLM (Groq by default — fast, cheap, reliable for this small job)
//   3. Creates the issue on the target repo and assigns it to Copilot's coding agent
//   4. Replies on Telegram with a confirmation and a link to the issue
//   5. (See webhook.js) When GitHub reports the resulting PR is ready, sends that too
//
// What this deliberately does NOT do:
//   - It does not write any code itself. GitHub's Copilot coding agent already
//     does that part — autonomously, with tests and self-review. This project
//     is only the bridge: turning a message into a well-formed task, and
//     turning GitHub's response back into a message.
//
// A small dashboard (dashboard.js, served at GET /) sits alongside this: it
// shows whether GitHub/Telegram/Groq are actually configured, lets your friend
// add standing instructions for the agent, and shows a live feed of what the
// bridge has done. See dashboard.js's header for exactly what it can and
// can't do.

import 'dotenv/config';
import express from 'express';
import { Octokit } from 'octokit';
import { mountGithubWebhook } from './webhook.js';
import { mountDashboard } from './dashboard.js';
import { sendTelegramMessage } from './telegram.js';
import { logEvent, getAgentInstructions } from './activity.js';

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_USER_ID,   // the one Telegram user ID allowed to use this — see the guard below
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_AGENT_ASSIGNEE,   // e.g. "copilot-swe-agent" — confirm the exact login in your repo's
                           // assignee dropdown first; GitHub's bot login slug can vary by org/repo
  GROQ_API_KEY,
  PORT = 3000,
} = process.env;

// TELEGRAM_ALLOWED_USER_ID is deliberately NOT required here — on first run it's
// blank on purpose, so the server can start, log whoever messages it, and let
// you copy their ID in. Every message is just ignored until it's set.
for (const [name, val] of Object.entries({
  TELEGRAM_BOT_TOKEN,
  GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_AGENT_ASSIGNEE, GROQ_API_KEY,
})) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}. Check .env.example.`);
    process.exit(1);
  }
}
if (!TELEGRAM_ALLOWED_USER_ID) {
  console.warn('TELEGRAM_ALLOWED_USER_ID is not set yet — message the bot once, copy the ID that gets logged (console or dashboard), and add it to .env.');
}

const app = express();

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Turns a loose, typo-prone message into a clean, well-scoped GitHub issue.
// Kept intentionally low-stakes: this only produces TEXT (a title and description),
// never touches code or takes any action itself — a wrong guess here just means an
// oddly-worded issue, not a real mistake, which is why a smaller/cheaper model is a
// legitimate fit for this specific step.
async function cleanUpIntoIssue(rawText) {
  const extra = getAgentInstructions();
  const systemPrompt = `You turn a short, casual message from a busy person into a clear GitHub issue for an AI coding agent to complete autonomously. Respond ONLY with valid JSON: {"title": "...", "body": "..."}. The title should be a concise summary. The body should restate the request clearly, and include a short "Acceptance criteria" checklist of what "done" looks like, inferred reasonably from the request. Do not invent unrelated requirements. If the request is too vague to act on, still produce your best reasonable interpretation rather than refusing.${extra ? `\n\nStanding instructions from the repo owner, apply these to every issue you write:\n${extra}` : ''}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b', // llama-3.1-8b-instant was deprecated by Groq in June 2026
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawText },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!parsed.title || !parsed.body) throw new Error('LLM did not return a usable title/body');
  return parsed;
}

async function createAndAssignIssue({ title, body }) {
  const { data: issue } = await octokit.rest.issues.create({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    title,
    body,
  });

  // Assigning the coding agent is a separate step from creation — done here so a
  // failure to assign doesn't also fail to create the issue, and so you get a
  // clear error specifically about assignment if the login slug is wrong.
  try {
    await octokit.rest.issues.addAssignees({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issue_number: issue.number,
      assignees: [GITHUB_AGENT_ASSIGNEE],
    });
  } catch (err) {
    console.error(`Issue #${issue.number} created, but assigning "${GITHUB_AGENT_ASSIGNEE}" failed: ${err.message}`);
    console.error('Check the exact assignee login in your repo\'s issue assignee dropdown in the GitHub UI.');
  }

  return issue;
}

// Telegram calls this with every message sent to the bot. Content type is
// JSON (unlike Twilio's form-encoded webhooks), so express.json() is scoped
// to just this route.
app.post('/telegram-webhook', express.json(), async (req, res) => {
  const message = req.body.message;
  if (!message) return res.status(200).send(); // not a plain text message (edit, sticker, etc.) — ignore

  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const messageText = (message.text || '').trim();

  // Single-user guard — this is a personal tool for one friend, not a public
  // product, so a simple allowlist check on Telegram's numeric user ID is the
  // right amount of security here. Unlike a phone number, there's no way to
  // know this ID in advance — the first message from a new person is
  // deliberately NOT masked in the log below, so setup is: message the bot
  // once, copy the ID that shows up in the dashboard's activity feed or the
  // console, put it in TELEGRAM_ALLOWED_USER_ID, restart.
  if (String(fromId) !== String(TELEGRAM_ALLOWED_USER_ID)) {
    console.warn(`Ignored Telegram message from unrecognized user id: ${fromId} (@${message.from?.username || 'no username'})`);
    logEvent('ignored', `Message from unrecognized Telegram user — id: <code>${fromId}</code>${message.from?.username ? ` (@${escapeForLog(message.from.username)})` : ''}. Put that id in TELEGRAM_ALLOWED_USER_ID to allow it.`);
    return res.status(200).send();
  }

  if (!messageText) {
    await sendTelegramMessage(chatId, "Didn't catch any text in that message — try again?");
    return res.status(200).send();
  }

  logEvent('sms-in', escapeForLog(messageText));

  try {
    const { title, body } = await cleanUpIntoIssue(messageText);
    const issue = await createAndAssignIssue({ title, body });
    logEvent('issue-created', `#${issue.number} "${title}" — <a href="${issue.html_url}" target="_blank">${issue.html_url}</a>`);
    await sendTelegramMessage(
      chatId,
      `Got it — created "${title}" as issue #${issue.number} and assigned it to the coding agent. I'll message you when a PR is ready: ${issue.html_url}`
    );
  } catch (err) {
    console.error('Error handling Telegram message:', err);
    logEvent('issue-failed', escapeForLog(err.message));
    await sendTelegramMessage(chatId, `Something went wrong creating that task — try rewording it? (${err.message})`);
  }

  res.status(200).send();
});

function escapeForLog(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

mountGithubWebhook(app);

mountDashboard(app, {
  connections: {
    GitHub: Boolean(GITHUB_TOKEN),
    Telegram: Boolean(TELEGRAM_BOT_TOKEN),
    Groq: Boolean(GROQ_API_KEY),
  },
  repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
  assignee: GITHUB_AGENT_ASSIGNEE,
});

app.listen(PORT, () => console.log(`friend-agent listening on port ${PORT} — dashboard at http://localhost:${PORT}/`));