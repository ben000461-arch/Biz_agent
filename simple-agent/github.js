// github.js — the GitHub connection. Uses a GitHub *App*: the owner installs it
// on their account and picks exactly which repositories it may touch (GitHub
// enforces that choice, not us). We only ever store the installation ID — no
// password, no long-lived token. When we need to act, we sign a short-lived
// proof with the app's private key and trade it for an hour-long token.
//
// This file only READS (repos, pull requests, build status).

import crypto from 'crypto';
import fs from 'fs';
import { NeedsReconnect } from './google.js';

const b64url = (b) => Buffer.from(b).toString('base64url');
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function createGitHub({ appId, slug, clientId, clientSecret, privateKey, publicUrl, vault, bases = {} }) {
  const API = (bases.api || 'https://api.github.com').replace(/\/$/, '');
  const WEB = (bases.web || 'https://github.com').replace(/\/$/, '');
  const redirectUri = `${String(publicUrl).replace(/\/$/, '')}/oauth/github/callback`;

  const pending = new Map(); // state -> { chatId, expires }
  const STATE_TTL = 10 * 60 * 1000;
  const tokenCache = new Map(); // installationId -> { token, expiresAt }

  // A 9-minute proof that "this is the app", signed with the private key.
  function appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
  }

  const gh = async (url, token, init = {}) => {
    const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'biz-agent',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    return res;
  };

  async function installationToken(chatId) {
    const rec = vault.get(chatId, 'github');
    if (!rec?.installationId) throw new NeedsReconnect('not connected');
    const id = String(rec.installationId);
    const cached = tokenCache.get(id);
    if (cached && Date.now() < cached.expiresAt) return cached.token;

    const res = await gh(`/app/installations/${encodeURIComponent(id)}/access_tokens`, appJwt(), { method: 'POST' });
    if (res.status === 404 || res.status === 403 || res.status === 401) {
      // Uninstalled / suspended on GitHub's side.
      vault.remove(chatId, 'github');
      tokenCache.delete(id);
      throw new NeedsReconnect('installation gone');
    }
    if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
    const data = await res.json();
    tokenCache.set(id, { token: data.token, expiresAt: new Date(data.expires_at).getTime() - 60_000 });
    return data.token;
  }

  async function call(chatId, path) {
    let res = await gh(path, await installationToken(chatId));
    if (res.status === 401) {
      // Token revoked or expired early: forget it and try once with a fresh
      // one. If the app was uninstalled, getting a fresh one fails and clears
      // the saved connection.
      const rec = vault.get(chatId, 'github');
      if (rec?.installationId) tokenCache.delete(String(rec.installationId));
      res = await gh(path, await installationToken(chatId));
      if (res.status === 401) throw new NeedsReconnect('token rejected');
    }
    if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
    return res.json();
  }

  async function repos(chatId) {
    const data = await call(chatId, '/installation/repositories?per_page=100');
    return (data.repositories || []).map((r) => ({ full: r.full_name, name: r.name, private: Boolean(r.private) }));
  }

  // Lets people say "the app repo" / "fire dept" — match against what they were granted.
  async function resolveRepo(chatId, hint) {
    const list = await repos(chatId);
    if (!list.length) return { error: "I don't have access to any repositories yet. Add some in your GitHub app settings (Installed GitHub Apps → Configure)." };
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(hint);
    if (!target) {
      if (list.length === 1) return { repo: list[0].full };
      return { error: `Which project? I can see: ${list.map((r) => r.name).join(', ')}` };
    }
    let m = list.filter((r) => norm(r.name) === target || norm(r.full) === target);
    if (m.length !== 1) m = list.filter((r) => norm(r.name).includes(target) || target.includes(norm(r.name)));
    if (m.length === 1) return { repo: m[0].full };
    if (m.length > 1) return { error: `A few match "${hint}" — which one? ${m.map((r) => r.name).join(', ')}` };
    return { error: `I can't see a project matching "${hint}". I can see: ${list.map((r) => r.name).join(', ')}` };
  }

  return {
    redirectUri,
    appUrl: `${WEB}/apps/${slug}`,

    startInstall(chatId) {
      for (const [s, v] of pending) if (Date.now() > v.expires) pending.delete(s);
      const state = crypto.randomBytes(16).toString('hex');
      pending.set(state, { chatId: String(chatId), expires: Date.now() + STATE_TTL });
      return `${WEB}/apps/${slug}/installations/new?state=${state}`;
    },

    // Callback: GitHub sends code + installation_id + state. We check the
    // person who just approved really has access to that installation, so no
    // one can attach somebody else's installation to their chat.
    async finishInstall(state, code, installationId) {
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry || Date.now() > entry.expires) throw new Error('This link expired — send /connect github again.');
      if (!/^\d+$/.test(String(installationId || ''))) throw new Error('GitHub did not say which account was connected. Try /connect github again.');

      const tokRes = await fetch(`${WEB}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(15_000),
      });
      const tok = await tokRes.json().catch(() => ({}));
      if (!tokRes.ok || !tok.access_token) {
        console.error(`GitHub token exchange failed: ${tok.error || tokRes.status}${tok.error_description ? ` — ${tok.error_description}` : ''}`);
        throw new Error('GitHub did not accept the sign-in. Try /connect github again.');
      }

      const instRes = await gh('/user/installations?per_page=100', tok.access_token);
      if (!instRes.ok) throw new Error('Could not confirm the GitHub installation. Try /connect github again.');
      const found = ((await instRes.json()).installations || []).find((i) => String(i.id) === String(installationId));
      if (!found || Number(found.app_id) !== Number(appId)) throw new Error("That GitHub installation doesn't belong to you. Try /connect github again.");

      const account = found.account?.login || null;
      vault.set(entry.chatId, 'github', { installationId: String(found.id) }, { label: account });
      // The user token is deliberately discarded — we only keep the installation.
      return { chatId: entry.chatId, account };
    },

    isConnected: (chatId) => Boolean(vault.get(chatId, 'github')),

    // Uninstalls the app on GitHub so access really ends, then forgets it.
    async disconnect(chatId) {
      const rec = vault.get(chatId, 'github');
      vault.remove(chatId, 'github');
      if (rec?.installationId) {
        tokenCache.delete(String(rec.installationId));
        try {
          await gh(`/app/installations/${encodeURIComponent(rec.installationId)}`, appJwt(), { method: 'DELETE' });
        } catch { /* local removal already done */ }
      }
    },

    repos,

    async openPulls(chatId, hint) {
      const r = await resolveRepo(chatId, hint);
      if (r.error) return { error: r.error };
      if (!REPO_RE.test(r.repo)) return { error: "That repository name looks odd — I won't touch it." };
      const data = await call(chatId, `/repos/${r.repo}/pulls?state=open&per_page=10`);
      return { repo: r.repo, pulls: data.map((p) => ({ number: p.number, title: p.title, user: p.user?.login, draft: Boolean(p.draft), updatedAt: p.updated_at })) };
    },

    async buildStatus(chatId, hint) {
      const r = await resolveRepo(chatId, hint);
      if (r.error) return { error: r.error };
      if (!REPO_RE.test(r.repo)) return { error: "That repository name looks odd — I won't touch it." };
      const data = await call(chatId, `/repos/${r.repo}/actions/runs?per_page=3`);
      return { repo: r.repo, runs: (data.workflow_runs || []).map((w) => ({ name: w.name, status: w.status, conclusion: w.conclusion, branch: w.head_branch, at: w.updated_at })) };
    },
  };
}

export function readPrivateKey(file) {
  return fs.readFileSync(file, 'utf8');
}
