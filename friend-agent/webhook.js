// friend-agent — GitHub webhook listener
//
// This is the "close the loop" half of the bridge. server.js sends the task
// IN; this file listens for GitHub's own events and messages the result back
// OUT via Telegram. Import and mount this alongside server.js's app, or run
// it as its own small process — either works, since it's stateless.
//
// Setup required on GitHub's side (can't be done from code — a repo owner
// action): Repo Settings -> Webhooks -> Add webhook -> point it at this
// server's public URL + /github-webhook, content type application/json,
// events: "Pull requests" and "Issues".

import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { sendTelegramMessage } from './telegram.js';
import { logEvent } from './activity.js';

const {
  TELEGRAM_ALLOWED_USER_ID, // the one chat these notifications go to — same ID server.js allowlists
  GITHUB_AGENT_ASSIGNEE,
  GITHUB_WEBHOOK_SECRET, // set this in the GitHub webhook config too — verified below
} = process.env;

export function mountGithubWebhook(app) {
  app.post('/github-webhook', express.json({
    // GitHub signs the raw body — capture it here so it can be verified below
    // before trusting anything in the payload.
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }), async (req, res) => {
    if (GITHUB_WEBHOOK_SECRET && !verifySignature(req)) {
      console.warn('Rejected webhook with invalid signature');
      logEvent('webhook-rejected', 'Invalid signature on incoming GitHub webhook');
      return res.status(401).send('Invalid signature');
    }

    const event = req.headers['x-github-event'];
    const payload = req.body;

    try {
      if (event === 'pull_request' && payload.action === 'opened') {
        const pr = payload.pull_request;
        const openedByAgent = pr.user?.login === GITHUB_AGENT_ASSIGNEE
          || (pr.body || '').includes(`#${payload.issue?.number}`);
        if (openedByAgent || pr.user?.login?.includes('copilot') || pr.user?.login?.includes('codex')) {
          logEvent('pr-opened', `"${pr.title}" — <a href="${pr.html_url}" target="_blank">${pr.html_url}</a>`);
          await sendTelegramMessage(TELEGRAM_ALLOWED_USER_ID, `PR is up: "${pr.title}" — ${pr.html_url}. Take a look when you get a chance.`);
        }
      }

      if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request.merged) {
        logEvent('pr-merged', `"${payload.pull_request.title}"`);
        await sendTelegramMessage(TELEGRAM_ALLOWED_USER_ID, `Merged: "${payload.pull_request.title}". That one's done.`);
      }

      if (event === 'check_suite' && payload.check_suite?.conclusion === 'failure') {
        logEvent('checks-failed', 'Checks failed on a PR the agent opened');
        await sendTelegramMessage(TELEGRAM_ALLOWED_USER_ID, `Heads up — checks failed on a PR the agent opened. Might need your input.`);
      }
    } catch (err) {
      console.error('Error processing GitHub webhook:', err);
      // Don't fail the webhook response over a Telegram error — GitHub will
      // retry failed webhooks, and we don't want duplicate messages from that.
    }

    res.status(200).send('ok');
  });
}

function verifySignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on mismatched lengths rather than returning false —
  // a malformed/short signature would otherwise 500 instead of cleanly 401ing.
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}