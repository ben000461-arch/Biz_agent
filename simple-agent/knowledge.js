// Office knowledge: what a business tells its Agent (supabase/office_knowledge.sql).
//
// Employees submit a note or a file; it WAITS until the owner approves it. Only approved items ever reach
// the AI, and then only as facts to use, never as instructions to follow. An owner's own submissions are
// approved as they're added. Everything is scoped to ONE business; an employee only sees what they sent.
//
// Files live in the private "office-files" bucket at <chat_id>/k/<id>/<name>. Only the agent server (with
// the service key) reads or writes them: no database or storage rule lets a signed-in person reach these
// directly. We keep the plain text of what we can read (text, CSV, and Excel when a safe reader is
// installed) so the owner can review it and the AI can use it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_RE = /^-?\d{1,20}$/;
const tidy = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// keep line breaks in notes; drop other control characters
const tidyText = (v, n) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, n);

export const LIMITS = {
  title: 120, note: 5000, fileBytes: 10 * 1024 * 1024, text: 100_000,
  pendingPerPerson: 25, perBusiness: 1000, reviewNote: 300, listMax: 300,
  planChars: 2000, planItemChars: 700,
};
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'rtf']);
// code and config files: read as plain text (never run)
export const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'r', 'lua', 'pl', 'scala', 'dart', 'vue', 'svelte', 'html', 'htm', 'css', 'scss', 'less', 'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'gradle', 'graphql', 'proto', 'tf', 'dockerfile', 'makefile', 'gitignore']);
const LATER_EXT = new Set(['doc', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'odt', 'png', 'jpg', 'jpeg', 'gif', 'heic', 'webp']);
const MIME = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

// Files that are secrets by their very name: never stored, whatever is inside.
const SECRET_NAMES = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks|ovpn|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.netrc|\.pgpass|credentials(\.json)?|service[-_]?account.*\.json|secrets?\.(json|ya?ml|toml))$/i;
// Passwords and keys inside text. We say WHAT kind we found, never the value.
const SECRET_PATTERNS = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an Amazon (AWS) key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a Stripe key', /\b(sk|rk)_live_[0-9a-zA-Z]{20,}/],
  ['an OpenAI / Anthropic key', /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{32,}/],
  ['a Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ['a Groq key', /\bgsk_[A-Za-z0-9]{40,}/],
  ['a login token', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/],
  ['a password or secret', /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*["'][^"'\s]{10,}["']/i],
];
export function findSecret(text) {
  const t = String(text || '');
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(t)) return kind;
  return '';
}
const secretMsg = (kind) => `This looks like it contains ${kind}. Take it out and try again: Agent should never hold passwords or keys.`;

// Word and Excel files are zip files. Before opening one, read its table of contents and refuse
// "zip bombs" (tiny files that unpack to gigabytes) and anything unusual. -> '' when fine
export function zipProblem(buf, { maxEntries = 5000, maxTotal = 100 * 1024 * 1024, maxRatio = 200 } = {}) {
  if (!buf || buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return 'not_zip';
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return 'not_zip';
  const entries = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) return 'too_big'; // ZIP64: far bigger than any office file we take
  if (entries > maxEntries || cdOff + cdSize > buf.length) return 'too_big';
  let p = cdOff, total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return 'not_zip';
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    if (usize === 0xffffffff || csize === 0xffffffff) return 'too_big';
    total += usize;
    if (total > maxTotal) return 'too_big';
    if (usize > 1024 * 1024 && usize / Math.max(1, csize) > maxRatio) return 'too_big';
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return '';
}
const withLimit = (promise, ms) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

// The Excel reader on npm (0.18.x) has known problems with booby-trapped files, so we only open Excel with
// 0.19.3 or newer (installed from SheetJS). Until then we ask for CSV.
function excelOk(xlsx) {
  const v = String(xlsx?.version || '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  return v.length >= 3 && (v[0] > 0 || v[1] > 19 || (v[1] === 19 && v[2] >= 3));
}

export function safeFileName(name) {
  const n = String(name ?? '').normalize('NFKC').replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (n || 'file').slice(-80);
}
const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

// Read what we can out of an uploaded file. -> Promise<{ text, mime } | { error, message }>
// Nothing in a file is ever run: we only pull text out of it.
export async function readFile(name, buf, { xlsx = null, pdf = null, docx = null, timeoutMs = 20000 } = {}) {
  const base = String(name || '').split('/').pop();
  const ext = extOf(base) || (/^(dockerfile|makefile)$/i.test(base) ? base.toLowerCase() : '');
  if (SECRET_NAMES.test(base)) return { error: 'secret', message: 'That file holds passwords or keys (like .env or a key file), so it can’t be added. Agent should never hold them.' };
  if (!buf?.length) return { error: 'empty', message: 'That file is empty.' };
  if (buf.length > LIMITS.fileBytes) return { error: 'too_big', message: 'That file is over 10 MB.' };
  const out = (text, mime) => {
    const t = tidyText(text, LIMITS.text);
    const kind = findSecret(t);
    if (kind) return { error: 'secret', message: secretMsg(kind) };
    return { text: t, mime };
  };
  if (TEXT_EXT.has(ext) || CODE_EXT.has(ext)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return { error: 'not_text', message: 'That file isn’t plain text. Save it as .txt or .csv and try again.' }; }
    if (text.includes('\u0000')) return { error: 'not_text', message: 'That file isn’t plain text. Save it as .txt or .csv and try again.' };
    return out(text.replace(/^\ufeff/, ''), MIME[ext] || 'text/plain');
  }
  if (ext === 'xlsx' || ext === 'xls') {
    if (!excelOk(xlsx)) return { error: 'excel_later', message: 'Excel files aren’t switched on yet. In Excel or Sheets, use File → Save as / Download → CSV, and upload that.' };
    const zip = buf[0] === 0x50 && buf[1] === 0x4b; // .xlsx is a zip
    const ole = buf[0] === 0xd0 && buf[1] === 0xcf;  // old .xls
    if ((ext === 'xlsx' && !zip) || (ext === 'xls' && !ole && !zip)) return { error: 'not_excel', message: 'That doesn’t look like an Excel file.' };
    if (zip && zipProblem(buf)) return { error: 'not_excel', message: 'That spreadsheet unpacks to something far too big or odd. Save it as CSV and try again.' };
    try {
      const wb = xlsx.read(buf, { type: 'buffer', dense: true, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, sheetRows: 2000 });
      const parts = [];
      for (const sn of (wb.SheetNames || []).slice(0, 10)) {
        const csv = xlsx.utils.sheet_to_csv(wb.Sheets[sn], { blankrows: false });
        if (csv.trim()) parts.push(`# Sheet: ${tidy(sn, 60)}\n${csv}`);
        if (parts.join('\n\n').length > LIMITS.text) break;
      }
      return out(parts.join('\n\n') || '(no data found)', MIME[ext]);
    } catch { return { error: 'not_excel', message: 'Couldn’t read that spreadsheet. Save it as CSV and try again.' }; }
  }
  if (ext === 'docx') {
    if (!docx?.extractRawText) return { error: 'type_later', message: 'Word files aren’t switched on yet. Paste the important part as a note, or save it as .txt.' };
    if (zipProblem(buf)) return { error: 'not_word', message: 'That doesn’t look like a Word file (or it unpacks to something far too big).' };
    try {
      const r = await withLimit(docx.extractRawText({ buffer: buf }), timeoutMs);
      const text = String(r?.value || '').trim();
      if (!text) return { error: 'no_text', message: 'That Word file has no text in it.' };
      return out(text, MIME.docx);
    } catch { return { error: 'not_word', message: 'Couldn’t read that Word file. Save it as .txt or PDF and try again.' }; }
  }
  if (ext === 'pdf') {
    if (!pdf?.getDocument) return { error: 'type_later', message: 'PDF files aren’t switched on yet. Paste the important part as a note.' };
    if (buf.subarray(0, 1024).indexOf('%PDF-') < 0) return { error: 'not_pdf', message: 'That doesn’t look like a PDF.' };
    let doc = null;
    try {
      const task = pdf.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, disableAutoFetch: true, disableStream: true, stopAtErrors: false, verbosity: 0 });
      doc = await withLimit(task.promise, timeoutMs);
      const pages = Math.min(doc.numPages, 300);
      const parts = []; let len = 0;
      const started = Date.now();
      for (let i = 1; i <= pages && len < LIMITS.text && Date.now() - started < timeoutMs; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        let line = '', lines = [];
        for (const it of tc.items) { line += it.str || ''; if (it.hasEOL) { lines.push(line); line = ''; } }
        if (line) lines.push(line);
        const t = lines.join('\n').replace(/[ \t]+\n/g, '\n').trim();
        if (t) { parts.push(`--- Page ${i} ---\n${t}`); len += t.length; }
        page.cleanup();
      }
      if (!parts.length) return { error: 'no_text', message: 'That PDF has no text in it (it’s probably a scan or photo). Paste the important part as a note for now.' };
      return out(parts.join('\n\n'), MIME.pdf);
    } catch (e) {
      if (e?.name === 'PasswordException') return { error: 'locked', message: 'That PDF has a password. Save a copy without it and try again.' };
      return { error: 'not_pdf', message: 'Couldn’t read that PDF. Try saving it again, or paste the important part as a note.' };
    } finally { try { await doc?.destroy(); } catch { /* ignore */ } }
  }
  if (LATER_EXT.has(ext)) return { error: 'type_later', message: ext === 'doc' ? 'Old Word files (.doc) aren’t supported. Save it as .docx or PDF and try again.' : 'Pictures and slides aren’t supported yet. Paste the important part as a note.' };
  return { error: 'type', message: 'That kind of file isn’t supported. Use a document, a spreadsheet, a PDF, or a code/text file.' };
}

// Pick the approved items that fit what was asked, for the AI. -> string ('' when nothing fits)
const STOP = new Set('the and for with that this from your you are was were what when where which who will would can could should have has had not but all any our out get got put make made into then than them they their there here about please just like also some more most very much need want help does did done able'.split(' '));
const words = (s) => [...new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))];
export function pickForPlan(items, query, { chars = LIMITS.planChars, itemChars = LIMITS.planItemChars } = {}) {
  const q = words(query);
  if (!q.length || !items?.length) return '';
  const scored = items.map((it) => {
    const t = ` ${words(it.title).join(' ')} `, b = ` ${words(it.body).join(' ')} `;
    let s = 0;
    for (const w of q) { if (t.includes(` ${w} `)) s += 3; else if (b.includes(` ${w} `)) s += 1; }
    return { it, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  let out = '';
  for (const { it } of scored) {
    const body = String(it.body || '').replace(/\s+/g, ' ').trim();
    const line = `- ${tidy(it.title, LIMITS.title)}: ${body.length > itemChars ? `${body.slice(0, itemChars)}…` : body}\n`;
    if (out.length + line.length > chars) { if (!out) out = line.slice(0, chars); break; }
    out += line;
  }
  return out.trim();
}

export function createKnowledge({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 10000, now = () => Date.now(), cacheMs = 60000, xlsx = null, pdf = null, docx = null, newId = () => crypto.randomUUID() } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);
  const auth = { apikey: secret, ...(secret.startsWith('eyJ') ? { authorization: `Bearer ${secret}` } : {}) };
  const BUCKET = 'office-files';

  async function call(path, { method = 'GET', body, prefer, raw = false, type } = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers = { ...auth, ...(prefer ? { Prefer: prefer } : {}), ...(body !== undefined ? { 'content-type': type || 'application/json' } : {}) };
      const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: ctl.signal });
      if (!res.ok) return { ok: false, status: res.status };
      if (raw && method === 'GET') return { ok: true, buf: Buffer.from(await res.arrayBuffer()) };
      const text = await res.text();
      return { ok: true, rows: text ? JSON.parse(text) : [] };
    } catch { return { ok: false, status: 0 }; } finally { clearTimeout(t); }
  }
  const rest = (path, o) => call(`/rest/v1/${path}`, o);
  const objUrl = (p) => `/storage/v1/object/${BUCKET}/${p.split('/').map(encodeURIComponent).join('/')}`;

  const okMember = (m) => m && CHAT_RE.test(String(m.chatId)) && UUID_RE.test(String(m.userId)) && (m.role === 'owner' || m.role === 'employee');
  const owner = (m) => m.role === 'owner';
  const COLS = 'id,ts,user_id,email,kind,title,file_name,size,status,reviewed_at,reviewed_by,review_note';
  const out = (r) => ({ id: r.id, ts: r.ts, kind: r.kind, title: r.title, fileName: r.file_name || null, size: r.size ?? null, status: r.status, email: r.email, mine: false, reviewedAt: r.reviewed_at || null, reviewNote: r.review_note || null });

  // ---- the AI's view: approved items for one business, cached a minute
  const cache = new Map();
  const forget = (chatId) => cache.delete(String(chatId));
  async function approved(chatId) {
    const hit = cache.get(String(chatId));
    if (hit && hit.until > now()) return hit.items;
    const r = await rest(`office_knowledge?chat_id=eq.${chatId}&status=eq.approved&select=title,body&order=ts.desc&limit=${LIMITS.listMax}`);
    if (!r.ok) return hit?.items || [];
    const items = r.rows.map((x) => ({ title: x.title, body: String(x.body || '').slice(0, 4000) }));
    cache.set(String(chatId), { items, until: now() + cacheMs });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return items;
  }
  async function forPlan(chatId, query) {
    if (!enabled || !CHAT_RE.test(String(chatId ?? ''))) return '';
    try { return pickForPlan(await approved(chatId), query); } catch { return ''; }
  }

  async function pendingCount(chatId) {
    if (!enabled || !CHAT_RE.test(String(chatId ?? ''))) return 0;
    const r = await rest(`office_knowledge?chat_id=eq.${chatId}&status=eq.pending&select=id&limit=200`);
    return r.ok ? r.rows.length : 0;
  }

  // owner: the whole business (waiting first, newest first). employee: only what they sent.
  async function list(m) {
    if (!enabled || !okMember(m)) return { error: 'unavailable' };
    const who = owner(m) ? '' : `&user_id=eq.${m.userId}`;
    const r = await rest(`office_knowledge?chat_id=eq.${m.chatId}${who}&select=${COLS}&order=ts.desc&limit=${LIMITS.listMax}`);
    if (!r.ok) return { error: 'unavailable' };
    const items = r.rows.map((x) => ({ ...out(x), mine: x.user_id === m.userId }));
    return { items };
  }

  async function getOne(m, id) {
    if (!UUID_RE.test(String(id))) return { error: 'not_found' };
    const who = owner(m) ? '' : `&user_id=eq.${m.userId}`;
    const r = await rest(`office_knowledge?id=eq.${id}&chat_id=eq.${m.chatId}${who}&select=${COLS},body,path,mime&limit=1`);
    if (!r.ok) return { error: 'unavailable' };
    return r.rows[0] ? { row: r.rows[0] } : { error: 'not_found' };
  }

  // the full text, for reviewing (owner) or checking what you sent (employee)
  async function read(m, id) {
    if (!enabled || !okMember(m)) return { error: 'unavailable' };
    const g = await getOne(m, id);
    if (g.error) return g;
    return { item: { ...out(g.row), mine: g.row.user_id === m.userId, body: g.row.body || '' } };
  }

  async function room(m) {
    const [mine, all] = await Promise.all([
      rest(`office_knowledge?chat_id=eq.${m.chatId}&user_id=eq.${m.userId}&status=eq.pending&select=id&limit=${LIMITS.pendingPerPerson + 1}`),
      rest(`office_knowledge?chat_id=eq.${m.chatId}&select=id&limit=${LIMITS.perBusiness + 1}`),
    ]);
    if (!mine.ok || !all.ok) return { error: 'unavailable' };
    if (!owner(m) && mine.rows.length >= LIMITS.pendingPerPerson) return { error: 'too_many_waiting' };
    if (all.rows.length >= LIMITS.perBusiness) return { error: 'full' };
    return { ok: true };
  }

  const fresh = (m) => (owner(m) ? { status: 'approved', reviewed_at: new Date(now()).toISOString(), reviewed_by: m.email || null } : { status: 'pending' });

  async function addNote(m, { title, text } = {}) {
    if (!enabled || !okMember(m)) return { error: 'unavailable' };
    const t = tidy(title, LIMITS.title), body = tidyText(text, LIMITS.note);
    if (!t) return { error: 'no_title' };
    if (!body) return { error: 'no_text' };
    if (String(text ?? '').length > LIMITS.note + 500) return { error: 'too_long' };
    const secret = findSecret(`${t}\n${body}`);
    if (secret) return { error: 'secret', message: secretMsg(secret) };
    const space = await room(m);
    if (space.error) return space;
    const row = { id: newId(), chat_id: String(m.chatId), user_id: m.userId, email: m.email || null, kind: 'note', title: t, body, ...fresh(m) };
    const r = await rest('office_knowledge', { method: 'POST', body: row, prefer: 'return=minimal' });
    if (!r.ok) return { error: 'unavailable' };
    if (row.status === 'approved') forget(m.chatId);
    return { ok: true, id: row.id, status: row.status };
  }

  async function addFile(m, { name, title, buf } = {}) {
    if (!enabled || !okMember(m)) return { error: 'unavailable' };
    const fileName = safeFileName(name);
    const read = await readFile(fileName, buf, { xlsx, pdf, docx });
    if (read.error) return read;
    const space = await room(m);
    if (space.error) return space;
    const id = newId();
    const path = `${m.chatId}/k/${id}/${fileName}`;
    const up = await call(objUrl(path), { method: 'POST', body: buf, raw: true, type: 'application/octet-stream' });
    if (!up.ok) return { error: 'unavailable' };
    const row = { id, chat_id: String(m.chatId), user_id: m.userId, email: m.email || null, kind: 'file', title: tidy(title, LIMITS.title) || tidy(fileName, LIMITS.title), body: read.text, file_name: fileName, size: buf.length, mime: read.mime, path, ...fresh(m) };
    const r = await rest('office_knowledge', { method: 'POST', body: row, prefer: 'return=minimal' });
    if (!r.ok) { await call(objUrl(path), { method: 'DELETE' }); return { error: 'unavailable' }; }
    if (row.status === 'approved') forget(m.chatId);
    return { ok: true, id, status: row.status };
  }

  async function review(m, id, decision, note) {
    if (!enabled || !okMember(m)) return { error: 'unavailable' };
    if (!owner(m)) return { error: 'owner_only' };
    if (decision !== 'approve' && decision !== 'reject') return { error: 'bad_decision' };
    const g = await getOne(m, id);
    if (g.error) return g;
    if (g.row.status !== 'pending') return { error: 'already_reviewed' };
    const patch = { status: decision === 'approve' ? 'approved' : 'rejected', reviewed_at: new Date(now()).toISOString(), reviewed_by: m.email || null, review_note: decision === 'reject' ? (tidy(note, LIMITS.reviewNote) || null) : null };
    const r = await rest(`office_knowledge?id=eq.${id}&chat_id=eq.${m.chatId}&status=eq.pending`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
    if (!r.ok) return { error: 'unavailable' };
    forget(m.chatId);
    return { ok: true, status: patch.status };
  }

  // owner: anything. employee: their own, only while it's waiting or was turned down (approved = the business's now)
  async function remove(m, id) {
    if (!enabled || !okMember(m)) return { error: 'unavailable' };
    const g = await getOne(m, id);
    if (g.error) return g;
    if (!owner(m) && g.row.status === 'approved') return { error: 'owner_only' };
    const r = await rest(`office_knowledge?id=eq.${id}&chat_id=eq.${m.chatId}`, { method: 'DELETE', prefer: 'return=minimal' });
    if (!r.ok) return { error: 'unavailable' };
    if (g.row.path) await call(objUrl(g.row.path), { method: 'DELETE' }); // the list row is gone either way
    forget(m.chatId);
    return { ok: true };
  }

  // the original file, for the owner (or the person who sent it)
  async function download(m, id) {
    if (!enabled || !okMember(m)) return { error: 'unavailable' };
    const g = await getOne(m, id);
    if (g.error) return g;
    if (g.row.kind !== 'file' || !g.row.path) return { error: 'not_found' };
    const r = await call(objUrl(g.row.path), { raw: true });
    if (!r.ok) return { error: r.status === 404 || r.status === 400 ? 'not_found' : 'unavailable' };
    return { buf: r.buf, name: g.row.file_name || 'file' };
  }

  return { enabled, list, read, addNote, addFile, review, remove, download, pendingCount, forPlan, forget, excel: excelOk(xlsx), pdf: !!pdf?.getDocument, word: !!docx?.extractRawText };
}
