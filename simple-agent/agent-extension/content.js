// Agent: the bar at the bottom of the page.
// Injected only when the employee opens Agent on this tab (toolbar button or Alt+Shift+A); running it again
// toggles the bar. Everything lives inside a closed Shadow DOM, so the page's styles can't break the bar and
// the bar can't break the page.
//
// Flow: the employee types a request -> we read the page (text + the fields, buttons and links on it, each with
// an id like "e7"; never passwords or card fields) -> the background worker asks the agent server for a plan ->
// the employee reviews it (can untick steps or change a value) -> Approve -> each step is done and re-checked.
(() => {
  if (window.__agentBar) { window.__agentBar.toggle(); return; }

  const MAX_ELEMENTS = 300;
  const send = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false, message: 'Agent was updated or restarted. Reload this page and try again.' } : r)); }
    catch { resolve({ ok: false, message: 'Agent was updated or restarted. Reload this page and try again.' }); }
  });

  // ------------------------------------------------------------------ sensitive data never leaves the page
  const luhn = (d) => { let s = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; };
  const mask = (t) => String(t ?? '')
    .replace(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, '[SSN hidden]')
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) ? '[card number hidden]' : m; });
  const SENSITIVE = /pass(word|code)?|\bpin\b|cvv|cvc|card.?(number|no)|cc-?(number|csc|exp)|security.?code|\bssn\b|social.?security/i;

  // ------------------------------------------------------------------ editors ("documents")
  // Two kinds of editor get the same treatment: rich text boxes on any site (an email body, a notes app, a
  // comment box: anything contenteditable), and Google Docs, which draws the page itself and takes typing
  // through a small hidden frame. For both we can READ the text, ADD text (as a paste, so formatting comes
  // through), SELECT ALL + DELETE, and UNDO, and every change is checked by reading the text again.
  const DOCS = { docs: true };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (t) => String(t ?? '').replace(/^﻿/, '').replace(/\s+/g, ' ').trim();
  const IN_DOCS = /\/document\/d\//.test(location.pathname);
  const IN_SLIDES = /\/presentation\/d\//.test(location.pathname);
  function docsTarget() {
    const f = document.querySelector('iframe.docs-texteventtarget-iframe');
    let d = null; try { d = f?.contentDocument; } catch { d = null; }
    return d ? (d.querySelector('[contenteditable="true"]') || d.body) : null;
  }
  // ---- Google Slides: each text box on the slide is drawn as a shape. To write in one we click into it (like
  // a person would), then type through the same hidden frame Docs uses.
  const PLACEHOLDER = /^click to add\b/i;
  function slidesBoxes() {
    const groups = new Map();
    for (const t of document.querySelectorAll('svg text')) {
      if (!visible(t) || t.closest('[class*="filmstrip"]')) continue;
      const g = t.closest('g[id]') || t.parentElement;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t.textContent);
    }
    const all = [...groups].map(([g, parts]) => ({ g, text: norm(parts.join(' ')) })).filter((b) => b.text);
    // Slides keeps other slides' boxes in the page too (stacked underneath, or cached). Only offer the boxes you
    // can actually see on the slide that's showing: something at that spot must belong to the same drawing.
    const pe = host?.style.pointerEvents; if (host) host.style.pointerEvents = 'none'; // look past Agent's own bar
    const shown = all.filter(({ g }) => {
      const r = g.getBoundingClientRect(); const svg = g.closest('svg');
      for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.3], [0.8, 0.7], [0.5, 0.2]]) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || g.contains(hit) || (svg && svg.contains(hit) && !otherBox(hit, g, all))) return true;
      }
      return false;
    });
    if (host) host.style.pointerEvents = pe || '';
    return shown.length ? shown : all; // if the check finds nothing, don't lose every box
  }
  const otherBox = (hit, g, all) => all.some((b) => b.g !== g && b.g.contains(hit) && !b.g.contains(g));
  // which slide is showing (Slides marks the selected thumbnail)
  // Which thumbnail is the slide on screen? Try, in order: the app marking it selected; the slide id in the address
  // (Slides puts "#slide=id.XXXX" there); the thumbnail's words matching the words on the big slide.
  function showingThumb(thumbs) {
    const marked = (th) => th.getAttribute('aria-selected') === 'true' || /selected/i.test(th.className?.baseVal ?? th.className ?? '')
      || Boolean(th.querySelector('[aria-selected="true"], [class*="selected"]'));
    let i = thumbs.findIndex(marked);
    if (i !== -1) return i;
    const id = (location.hash.match(/slide=id\.([\w-]+)/) || [])[1];
    if (id) { i = thumbs.findIndex((th) => (th.closest('[id]')?.outerHTML || th.outerHTML).includes(id)); if (i !== -1 && thumbs.filter((th) => th.outerHTML.includes(id)).length <= 1) return i; }
    const onSlide = squash(slidesBoxes().map((b) => b.text).filter((t) => !PLACEHOLDER.test(t)).join(' '));
    if (onSlide) { const hits = thumbs.map((th, k) => (squash(th.textContent) === onSlide ? k : -1)).filter((k) => k !== -1); if (hits.length === 1) return hits[0]; }
    return -1;
  }
  function slidesThumbs() { return [...document.querySelectorAll('.punch-filmstrip-thumbnail, [class*="filmstrip-thumbnail"]')].filter(visible); }
  function dbl(target) {
    press(target);
    const r = target.getBoundingClientRect(), w = target.ownerDocument.defaultView || window;
    target.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, cancelable: true, view: w, detail: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }

  // real mouse presses: menus and toolbars in web apps often ignore a bare .click()
  function press(target) {
    const r = target.getBoundingClientRect();
    const w = target.ownerDocument.defaultView || window;
    const o = { bubbles: true, cancelable: true, view: w, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ['pointerover', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) target.dispatchEvent(t.startsWith('pointer') ? new w.PointerEvent(t, o) : new w.MouseEvent(t, o));
  }
  async function docsMenu(menuId, itemName) {
    const menu = document.getElementById(menuId);
    if (!menu) return false;
    press(menu); await sleep(150);
    const items = [...document.querySelectorAll('.goog-menuitem')].filter((m) => visible(m) && !m.classList.contains('goog-menuitem-disabled'));
    const item = items.find((m) => norm(m.querySelector('.goog-menuitem-label')?.textContent ?? m.textContent).toLowerCase().startsWith(itemName.toLowerCase()));
    if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); press(menu); return false; }
    press(item); await sleep(120);
    return true;
  }
  const KEYCODES = { a: 65, z: 90, Backspace: 8 };
  function key(t, k, code, mods = {}) {
    for (const type of ['keydown', 'keyup']) t.dispatchEvent(new KeyboardEvent(type, { key: k, code, keyCode: KEYCODES[k] || 0, which: KEYCODES[k] || 0, bubbles: true, cancelable: true, ...mods }));
  }
  const MOD = /Mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

  // Docs' text: its plain-text export, fetched by the extension's background (Docs sends the file from a
  // different Google address, which a page can't follow). Falls back to the lines Docs shows on screen.
  function docsScreenText() {
    const paras = [...document.querySelectorAll('.kix-canvas-tile-content g[role="paragraph"]')];
    if (paras.length) return paras.map((g) => [...g.querySelectorAll('rect[aria-label]')].map((r) => r.getAttribute('aria-label')).join('')).join('\n');
    const old = document.querySelector('.kix-paginateddocumentplugin, .kix-appview-editor .kix-page');
    return old ? old.innerText : null;
  }
  async function slidesRead() {
    const r = await send({ type: 'docText' });
    return r?.ok && typeof r.text === 'string' ? r.text.replace(/^\uFEFF/, '') : null;
  }
  async function docsRead() {
    const r = await send({ type: 'docText' });
    if (r?.ok && typeof r.text === 'string') return r.text.replace(/^﻿/, '');
    return docsScreenText();
  }

  // ---- how the text LOOKS now (font, size, spacing, indent, alignment), so new text can match it
  const toPt = (v) => { const m = String(v || '').match(/([\d.]+)\s*(pt|px)?/); if (!m) return null; const n = parseFloat(m[1]) * (m[2] === 'px' ? 0.75 : 1); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
  const firstFont = (f) => { const x = String(f || '').split(',')[0].replace(/["']/g, '').trim(); return /^[A-Za-z][A-Za-z0-9 '-]{0,39}$/.test(x) ? x : null; };
  const spacingOf = (lh) => { const n = parseFloat(lh); if (!Number.isFinite(n)) return null; return n >= 1.8 ? 'double' : n >= 1.4 ? '1.5' : 'single'; };
  const styleKey = (st) => JSON.stringify(st);
  function commonStyle(list) { // the look most body paragraphs share
    const count = new Map(); let best = null, n = 0;
    for (const st of list) { const k = styleKey(st); const c = (count.get(k) || 0) + 1; count.set(k, c); if (c > n) { n = c; best = st; } }
    return best && Object.keys(best).length ? best : null;
  }
  function parseCss(css) { const map = {}; for (const m of String(css).matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) map[m[1]] = (map[m[1]] || '') + ';' + m[2]; return map; }
  function decl(text) { const out = {}; for (const part of String(text).split(';')) { const i = part.indexOf(':'); if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); } return out; }
  // Docs: its formatted export, as paragraphs with their look (classes and inline styles)
  async function docsParagraphStyles() {
    const r = await send({ type: 'docText', format: 'html' });
    if (!r?.ok || typeof r.text !== 'string') return null;
    const d = new DOMParser().parseFromString(r.text, 'text/html');
    const cls = parseCss([...d.querySelectorAll('style')].map((x) => x.textContent).join('\n'));
    const of = (node) => decl([...(node.classList || [])].map((c) => cls[c] || '').join(';') + ';' + (node.getAttribute('style') || ''));
    return [...d.querySelectorAll('body p, body li')].filter((p) => norm(p.textContent)).map((p) => {
      const ps = of(p); const span = p.querySelector('span') || p; const ss = { ...ps, ...of(span) };
      const st = {};
      const font = firstFont(ss['font-family']); if (font) st.font = font;
      const size = toPt(ss['font-size']); if (size) st.size = size;
      const sp = spacingOf(ps['line-height']); if (sp) st.spacing = sp;
      st.indent = Boolean(toPt(ps['text-indent']));
      if (['center', 'right', 'justify'].includes(ps['text-align'])) st.align = ps['text-align'];
      const heading = /^H\d$/.test(p.tagName) || p.classList.contains('title') || st.align === 'center' || Number(ss['font-weight']) >= 600 || ss['font-weight'] === 'bold';
      return { st, heading, text: norm(p.textContent) };
    });
  }
  // any other editor: what the browser actually shows for its paragraphs
  function richParagraphStyles(el) {
    const w = el.ownerDocument.defaultView;
    const blocks = [...el.querySelectorAll('p, div, li')].filter((b) => norm(b.textContent) && !b.querySelector('p, div, li'));
    return (blocks.length ? blocks : [el]).slice(0, 40).map((b) => {
      const cs = w.getComputedStyle(b); const st = {};
      const font = firstFont(cs.fontFamily); if (font) st.font = font;
      const px = parseFloat(cs.fontSize); if (px) st.size = Math.round(px * 0.75);
      const lh = parseFloat(cs.lineHeight); if (lh && px) st.spacing = spacingOf(lh / px);
      st.indent = parseFloat(cs.textIndent) > 0;
      if (['center', 'right', 'justify'].includes(cs.textAlign)) st.align = cs.textAlign;
      return { st, heading: parseInt(cs.fontWeight, 10) >= 600 || st.align === 'center', text: norm(b.textContent) };
    });
  }
  const bodyStyle = (paras) => paras && commonStyle(paras.filter((p) => !p.heading).map((p) => p.st));

  const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // "# Title", "## Heading", blank line = new paragraph, plus an optional style  ->  clean HTML for pasting.
  // Every paragraph gets its own explicit style, so nothing leaks over from the title (or from what was there).
  function docHtml(text, style = {}) {
    const size = style.size || 11;
    const lh = { single: '1.15', '1.5': '1.5', double: '2' }[style.spacing] || '1.15';
    const font = style.font ? `font-family:'${style.font.replace(/'/g, '')}';` : '';
    const gap = style.spacing === 'double' ? 0 : 8;
    const base = `margin:0 0 ${gap}pt 0;line-height:${lh};${font}color:#000;font-style:normal;text-decoration:none;`;
    return String(text).replace(/\r/g, '').split(/\n\s*\n/).filter((b) => b.trim()).map((block) => {
      const one = !block.trim().includes('\n');
      if (one && /^\s*#\s+/.test(block)) return `<p style="${base}text-align:center;font-size:${size + 5}pt;font-weight:700">${esc(block.trim().replace(/^#\s+/, ''))}</p>`;
      if (one && /^\s*##\s+/.test(block)) return `<p style="${base}text-align:left;font-size:${size + 2}pt;font-weight:700">${esc(block.trim().replace(/^##\s+/, ''))}</p>`;
      const indent = typeof style.indent === 'boolean' ? style.indent : /^(\t| {2,})/.test(block);
      return `<p style="${base}text-align:${style.align || 'left'};font-size:${size}pt;font-weight:400;${indent ? 'text-indent:36pt;' : 'text-indent:0;'}">${block.trim().split('\n').map((l) => esc(l.trim())).join('<br>')}</p>`;
    }).join('');
  }
  const docPlain = (text) => String(text).replace(/\r/g, '').replace(/^[ \t]*#{1,2}\s+/gm, '').replace(/^(\t| {2,})/gm, '');
  function pasteInto(t, text, style) {
    const html = docHtml(text, style), plain = docPlain(text);
    const dt = new DataTransfer();
    dt.setData('text/plain', plain);
    dt.setData('text/html', `<meta charset="utf-8">${html}`);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    t.dispatchEvent(ev);
    if (ev.defaultPrevented) return;
    const d = t.ownerDocument; // nobody took the paste: insert it ourselves
    if (!d.execCommand('insertHTML', false, html)) d.execCommand('insertText', false, plain);
  }

  // one interface for every kind of editor
  function editorFor(ref) {
    if (ref?.slides) {
      const box = ref; const t = () => docsTarget();
      const gid = box.g.id; // Slides may redraw the box: find it again by its id, or else by where it sits
      const r0 = box.g.getBoundingClientRect(); const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
      const g = () => {
        const byId = gid && document.getElementById(gid);
        if (byId) return byId;
        if (box.g.isConnected) return box.g;
        let best = null, d = 60;
        for (const b of slidesBoxes()) { const r = b.g.getBoundingClientRect(); const dd = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy); if (dd < d) { d = dd; best = b.g; } }
        return best || box.g;
      };
      const lines = () => norm([...g().querySelectorAll('text')].map((x) => x.textContent).join(' ') || g().textContent);
      return {
        docs: true, el: box.g,
        // the text of THIS box, so we check our words landed here and not in a new box somewhere else
        boxText: () => (g()?.isConnected ? lines() : null),
        read: slidesRead,
        async prepare() { dbl(box.g); await sleep(250); t()?.focus(); },
        async selectAll() { key(t(), 'a', 'KeyA', MOD); await sleep(80); },
        async deleteSelection() { key(t(), 'Backspace', 'Backspace'); await sleep(80); },
        async insert(text, style) { const x = t(); x.focus(); pasteInto(x, text, style); },
        async undoOnce() { if (!(await docsMenu('docs-edit-menu', 'Undo'))) key(t(), 'z', 'KeyZ', MOD); },
        paragraphStyles: async () => null,
        ready: () => box.g.isConnected && Boolean(t()),
        isEmpty: () => PLACEHOLDER.test(lines()),
        realEnter: async () => { const ok = await realAt(g(), 'dblclick'); await sleep(350); t()?.focus(); return ok; },
      };
    }
    if (ref === DOCS) {
      return {
        docs: true, el: null,
        read: docsRead,
        async selectAll() { const t = docsTarget(); if (!(await docsMenu('docs-edit-menu', 'Select all'))) key(t, 'a', 'KeyA', MOD); },
        async deleteSelection() { const t = docsTarget(); if (!(await docsMenu('docs-edit-menu', 'Delete'))) key(t, 'Backspace', 'Backspace'); },
        async insert(text, style) { const t = docsTarget(); t.focus(); pasteInto(t, text, style); },
        async undoOnce() { const t = docsTarget(); if (!(await docsMenu('docs-edit-menu', 'Undo'))) key(t, 'z', 'KeyZ', MOD); },
        paragraphStyles: docsParagraphStyles,
        ready: () => Boolean(docsTarget()),
      };
    }
    const el = ref, d = el.ownerDocument; // the editor may sit inside a same-site panel (iframe)
    const sel = () => d.getSelection();
    const inside = () => { const s = sel(); return s && s.rangeCount && el.contains(s.anchorNode); };
    const caretToEnd = () => { const r = d.createRange(); r.selectNodeContents(el); r.collapse(false); const s = sel(); s.removeAllRanges(); s.addRange(r); };
    return {
      docs: false, el,
      async read() { return el.isConnected ? el.innerText : null; },
      async selectAll() { el.focus(); const r = d.createRange(); r.selectNodeContents(el); const s = sel(); s.removeAllRanges(); s.addRange(r); },
      async deleteSelection() { if (!d.execCommand('delete', false, null)) { el.textContent = ''; fire(el, 'input'); } },
      async insert(text, style) { el.focus(); const has = norm(el.innerText); if (!inside() || has) caretToEnd(); if (has) d.execCommand('insertParagraph', false, null); pasteInto(el, text, style); fire(el, 'input'); }, // added at the end, on a new line
      async undoOnce() { el.focus(); d.execCommand('undo', false, null); },
      paragraphStyles: async () => richParagraphStyles(el),
      ready: () => el.isConnected,
    };
  }
  // ---- writing AT A SPOT: right after some text that's there now, or in place of it (filling a blank)
  const count = (hay, needle) => { let c = 0, i = 0; const h = norm(hay).toLowerCase(), n = norm(needle).toLowerCase(); if (!n) return 0; while ((i = h.indexOf(n, i)) !== -1) { c++; i += n.length; } return c; };
  function setField(input, v) {
    input.focus();
    const set = nativeSetter(input); if (set) set.call(input, v); else input.value = v;
    fire(input, 'input', 'change');
    const w = input.ownerDocument.defaultView;
    input.dispatchEvent(new w.KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  }
  const btnByText = (root, re) => [...root.querySelectorAll('[role="button"], button')].find((b) => visible(b) && re.test(clean(b.innerText || b.getAttribute('aria-label') || '')));
  // Google Docs: its own Edit → Find and replace (only ever on text that's there exactly once, or the first match)
  async function docsInsertAt(find, value, swap) {
    if (!(await docsMenu('docs-edit-menu', 'Find and replace'))) return { ok: false, why: 'I couldn’t open Find and replace' };
    await sleep(350);
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => visible(d) && /find and replace/i.test(`${d.getAttribute('aria-label') || ''} ${d.innerText || ''}`));
    const inputs = dlg ? [...dlg.querySelectorAll('input:not([type]), input[type="text"]')].filter(visible) : [];
    if (inputs.length < 2) return { ok: false, why: 'Find and replace didn’t open the way I expected' };
    setField(inputs[0], find); await sleep(200);
    setField(inputs[1], swap ? value : `${find} ${value}`); await sleep(200);
    const all = btnByText(dlg, /^replace all$/i), one = btnByText(dlg, /^replace$/i), next = btnByText(dlg, /^next$/i);
    const many = count(await docsRead() || '', find) > 1;
    if (many && one) { if (next) { press(next); await sleep(200); } press(one); } else if (all) press(all); else return { ok: false, why: 'I couldn’t find the Replace button' };
    await sleep(250);
    const close = dlg.querySelector('[aria-label="Close" i]') || btnByText(dlg, /^(done|close|cancel)$/i);
    if (close) press(close); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { ok: true };
  }
  // any other editor: find the text in the page itself and type there
  function richInsertAt(el, find, value, swap) {
    const d = el.ownerDocument, walker = d.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const i = node.data.indexOf(find); if (i === -1) continue;
      const r = d.createRange();
      if (swap) { r.setStart(node, i); r.setEnd(node, i + find.length); } else { r.setStart(node, i + find.length); r.collapse(true); }
      el.focus(); const s = d.getSelection(); s.removeAllRanges(); s.addRange(r);
      if (!d.execCommand('insertText', false, swap ? value : ` ${value}`)) return { ok: false, why: 'the editor didn’t take the text' };
      fire(el, 'input');
      return { ok: true };
    }
    return { ok: false, why: 'I couldn’t find that spot in the text' };
  }

  // re-read the text until the check passes (Docs saves within a few seconds), or give up honestly
  async function confirmText(ed, test) {
    for (let i = 0; i < (ed.docs ? 8 : 4); i++) {
      await sleep(ed.docs ? (i ? 700 : 900) : 120);
      const t = await ed.read(); if (t == null) return null;
      if (test(norm(t))) return true;
    }
    return false;
  }

  // what Agent changed, so it can be taken back: one list per run, newest last
  let undoRuns = [];
  let runLog = null; // the run in progress collects its entries here

  // compare text ignoring spaces and line breaks: a long title wraps onto two lines on the slide
  const squash = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const waitFor = async (test, ms = 2500) => { for (let t = 0; t < ms; t += 250) { if (test()) return true; await sleep(250); } return test(); };

  // Google Slides: leave whatever box we're in, real double-click into THIS box, real typing, then check the words
  // are in THIS box. If they aren't, take them back out and only say so once the slide really is back.
  // Escape in the page (never in Agent's own bar, where Escape closes the bar)
  async function leaveBox() { const t = docsTarget(); if (!t) return; t.focus(); await sleep(30); if (host && document.activeElement === host) return; await realKeys([{ t: 'key', key: 'Escape' }]); }
  async function slidesWrite(ed, step, beforeRaw, boxBefore) {
    const want = norm(docPlain(step.value || '')); const probe = want.slice(0, 60);
    const hasText = !ed.isEmpty();
    // (a real double-click on this box also takes Slides out of any other box it was in)
    if (!(await ed.realEnter())) return null;
    const keys = [];
    let ops = 0;
    if ((step.do === 'replace' || step.do === 'clear') && hasText) { keys.push({ t: 'key', key: 'SelectAll' }, { t: 'key', key: 'Backspace' }); ops++; }
    if (step.do !== 'clear') { keys.push({ t: 'type', text: docPlain(step.value || '') }); ops++; }
    if (keys.length && !(await realKeys(keys))) return { ok: false, why: 'the mouse and keyboard stopped responding' };
    const box = () => squash(ed.boxText() || '');
    const good = step.do === 'clear' ? () => ed.isEmpty() || box() === ''
      : () => box().includes(squash(probe)) && box() !== squash(boxBefore) && (step.do !== 'replace' || !hasText || !box().includes(squash(boxBefore)) || squash(boxBefore).includes(squash(probe)));
    if (await waitFor(good)) {
      if (ops) runLog?.push({ ed, ops, before: beforeRaw });
      await leaveBox(); // step out of the box so the next step starts clean
      return { ok: true };
    }
    // not in that box: undo what we typed, then make sure it's really gone before saying so
    for (let i = 0; i < ops; i++) { await ed.undoOnce(); await sleep(300); }
    await leaveBox();
    let gone = step.do === 'clear' || squash(beforeRaw).includes(squash(probe));
    for (let i = 0; !gone && i < 6; i++) { if (!squash(await ed.read()).includes(squash(probe))) gone = true; else await sleep(600); }
    return gone
      ? { ok: false, why: 'Slides didn’t let me into that box, so I took my text back out' }
      : { ok: false, why: 'Slides put my text somewhere other than that box and I couldn’t take it back out. Please delete the extra text on the slide' };
  }

  // the slide on screen: the biggest drawing that isn't a thumbnail
  function slideCanvas() {
    let best = null, area = 0;
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.closest('[class*="filmstrip"]') || (host && host.contains(svg)) || !visible(svg)) continue;
      const r = svg.getBoundingClientRect(); const a = r.width * r.height;
      if (a > area && r.width > 300 && r.height > 160) { area = a; best = svg; }
    }
    return best;
  }
  // text anywhere on the slide that's showing (not the thumbnails)
  const slideHas = (want) => [...document.querySelectorAll('svg text')].some((t) => !t.closest('[class*="filmstrip"]') && visible(t) && squash(t.closest('g[id]')?.textContent || t.textContent).includes(want));
  // write by feeling around: double-click where the title / main text normally is, type, check it shows up there
  async function slidesProbe(step, spot) {
    if (!['fill', 'replace'].includes(step.do)) return { ok: false, why: 'I can only type into a spot on the slide' };
    const svg = slideCanvas(); if (!svg) return { ok: false, why: 'I couldn’t find the slide on the screen' };
    const r = pageRect(svg);
    const tries = spot === 'title' ? [[0.5, 0.2], [0.3, 0.16], [0.5, 0.32]] : [[0.5, 0.55], [0.3, 0.45], [0.5, 0.7]];
    const want = norm(docPlain(step.value || '')); const probe = squash(want.slice(0, 60));
    if (!probe) return { ok: false, why: 'there was nothing to type' };
    const before = await slidesRead().catch(() => null);
    const ed = { docs: true, read: slidesRead, async undoOnce() { if (!(await docsMenu('docs-edit-menu', 'Undo'))) key(docsTarget(), 'z', 'KeyZ', MOD); } };
    for (const [fx, fy] of tries) {
      if (!(await realAt({ x: r.x + r.w * fx, y: r.y + r.h * fy }, 'dblclick'))) return { ok: false, why: 'I couldn’t use the mouse here' };
      await sleep(350); docsTarget()?.focus();
      const keys = step.do === 'replace' ? [{ t: 'key', key: 'SelectAll' }, { t: 'key', key: 'Backspace' }] : [];
      keys.push({ t: 'type', text: docPlain(step.value || '') });
      await realKeys(keys);
      if (await waitFor(() => slideHas(probe), 2000)) {
        runLog?.push({ ed, ops: keys.length > 1 ? 2 : 1, before });
        await leaveBox();
        return { ok: true };
      }
      // nothing showed up: typing with no box open does nothing in Slides, so try the next spot
      await leaveBox();
    }
    return { ok: false, why: `I felt around the ${spot === 'title' ? 'title' : 'main text'} area of the slide but found no box to type in` };
  }

  async function editDo(step, ref) {
    if (ref?.probe) return slidesProbe(step, ref.probe);
    const ed = editorFor(ref);
    if (!ed.ready()) return { ok: false, why: 'the editor isn’t ready; click into it and try again' };
    if (step.do === 'undo') return undoSome(step.value === 'all' ? 'all' : 'last');
    if (step.do === 'insert') {
      if (ref?.slides) return { ok: false, why: 'I can’t write at a spot inside a slide yet; I can rewrite the whole text box' };
      const beforeRaw = await ed.read();
      if (beforeRaw != null && !count(beforeRaw, step.find)) return { ok: false, why: `I couldn’t find “${clean(step.find, 40)}” in the document` };
      if (ed.el) { ed.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(120); flash(ed.el); }
      const done = ed.docs ? await docsInsertAt(step.find, step.value, step.swap) : richInsertAt(ed.el, step.find, step.value, step.swap);
      if (!done.ok) return done;
      runLog?.push({ ed, ops: 1, before: beforeRaw });
      const want = norm(step.swap ? step.value : `${step.find} ${step.value}`).toLowerCase();
      const had = count(beforeRaw || '', want);
      const ok = await confirmText(ed, (now) => count(now, want) > had);
      if (ok === null) return { ok: true, unverified: true };
      return ok ? { ok: true } : { ok: false, why: 'the text didn’t land where I expected' };
    }
    if (ed.el) { ed.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(150); flash(ed.el); }
    const beforeRaw = await ed.read();
    const before = norm(beforeRaw);
    const boxBefore = ed.boxText ? ed.boxText() : null; // what the target box said before we touched it
    if (ed.boxText && ed.realEnter) {
      const r = await slidesWrite(ed, step, beforeRaw, boxBefore);
      if (r) return r; // null = the real mouse isn't available here: fall back to the old way below
    }
    if (ed.prepare) await ed.prepare(); // e.g. click into a Slides text box first
    // new text matches the document's current look; anything the employee asked for goes on top
    const current = before ? bodyStyle(await ed.paragraphStyles().catch(() => null)) : null;
    const style = { ...(current || {}), ...(step.style || {}) };
    let ops = 0;
    const hasText = ed.isEmpty ? !ed.isEmpty() : Boolean(before);
    if (step.do === 'clear' || step.do === 'replace') { if (hasText) { await ed.selectAll(); await ed.deleteSelection(); ops++; } }
    if (step.do === 'fill' || step.do === 'replace') { await ed.insert(step.value || '', style, true); ops++; }
    if (ops) runLog?.push({ ed, ops, before: beforeRaw });
    const want = norm(docPlain(step.value || ''));
    const probe = want.slice(0, 60);
    const ok = await confirmText(ed, (now) => (step.do === 'clear' ? (ed.isEmpty ? now.length < before.length || before === '' : now === '')
      : step.do === 'replace' ? (ed.isEmpty ? now.includes(probe) : now.startsWith(probe) && now.length <= want.length + 200) // the old text is gone
      : now.includes(probe) && (now.length > before.length || ed.isEmpty?.() === false)));
    if (ok === null && !ed.boxText) return { ok: true, unverified: true };        // couldn't re-read the text: say so
    if (!ok && !ed.boxText) return { ok: false, why: 'the text didn’t change the way I expected' };
    // A box we aimed at (Slides): the words must be IN that box. If the app didn't let us into it, they went
    // somewhere else (Slides drops pasted text into a new box in the corner), so take them back out and say so.
    if (ed.boxText) {
      const landed = () => { const now = squash(ed.boxText() || ''); return now.includes(squash(probe)) && now !== squash(boxBefore); }; // in THIS box, and the box changed
      const inBox = landed();
      if (!inBox) {
        for (let i = 0; i < ops + 2 && norm(await ed.read()) !== norm(beforeRaw); i++) { await ed.undoOnce(); await sleep(250); }
        runLog?.pop();
        // second try, the way a person does it: real double-click into the box, then real typing
        if (ed.realEnter && (await ed.realEnter())) {
          const keys = [];
          if (step.do === 'replace' && hasText) keys.push({ t: 'key', key: 'SelectAll' }, { t: 'key', key: 'Backspace' });
          keys.push({ t: 'type', text: docPlain(step.value || '') });
          await realKeys(keys);
          await sleep(500);
          if (landed()) { runLog?.push({ ed, ops: keys.length, before: beforeRaw }); return { ok: true }; }
          for (let i = 0; i < 4 && norm(await ed.read()) !== norm(beforeRaw); i++) { await ed.undoOnce(); await sleep(300); }
        }
        if (squash(await ed.read()).includes(squash(probe)) && !squash(beforeRaw).includes(squash(probe)))
          return { ok: false, why: 'Slides put my text somewhere other than that box and I couldn’t take it back out. Please delete the extra text on the slide' };
        return { ok: false, why: 'Slides didn’t let me click into that box, even with the mouse, so I took my text back out' };
      }
    }
    // asked for a particular look? check the paragraphs really have it
    if (step.style && step.do !== 'clear') {
      const paras = await ed.paragraphStyles().catch(() => null);
      const mine = paras?.filter((p) => !p.heading && want.includes(p.text.slice(0, 40)));
      if (!mine?.length) return { ok: true, unverified: true };
      const off = mine.filter((p) => (typeof step.style.indent === 'boolean' && p.st.indent !== step.style.indent)
        || (step.style.font && p.st.font && p.st.font.toLowerCase() !== step.style.font.toLowerCase())
        || (step.style.spacing && p.st.spacing && p.st.spacing !== step.style.spacing));
      if (off.length) return { ok: false, why: 'the text is in, but the formatting didn’t fully take' };
    }
    return { ok: true };
  }

  async function undoEntry(e) {
    if (e.field) { // a field Agent filled: put the old value back
      if (!e.field.isConnected) return false;
      const set = nativeSetter(e.field); if (set) set.call(e.field, e.prev); else e.field.value = e.prev;
      fire(e.field, 'input', 'change'); return e.field.value === e.prev;
    }
    for (let i = 0; i < e.ops; i++) { await e.ed.undoOnce(); await sleep(e.ed.docs ? 250 : 60); }
    if (e.before == null) return null;
    for (let extra = 0; extra < 4; extra++) { // editors sometimes split one change into two undo steps
      const ok = await confirmText(e.ed, (now) => now === norm(e.before));
      if (ok !== false) return ok;
      await e.ed.undoOnce();
    }
    return false;
  }
  async function undoSome(which) {
    const runs = which === 'all' ? undoRuns.splice(0) : undoRuns.splice(-1);
    if (!runs.length) return { ok: false, why: 'there’s nothing of mine to undo here' };
    let unsure = false;
    for (const run of runs.reverse()) for (const e of [...run].reverse()) {
      const r = await undoEntry(e);
      if (r === false) return { ok: false, why: 'the page didn’t go back the way I expected; try ⌘Z / Ctrl+Z' };
      if (r === null) unsure = true;
    }
    refreshUndoButtons();
    return unsure ? { ok: true, unverified: true } : { ok: true };
  }

  // ------------------------------------------------------------------ reading the page
  let host = null;
  const refs = new Map(); // "e7" -> element, for this snapshot only

  const clean = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  function visible(el) {
    if (!el.isConnected || (host && host.contains(el))) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }
  function labelOf(el) {
    const by = el.getAttribute('aria-labelledby');
    const d = el.ownerDocument;
    if (by) { const t = by.split(/\s+/).map((id) => d.getElementById(id)?.innerText || '').join(' '); if (clean(t)) return clean(t); }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    if (el.id) { const l = d.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && clean(l.innerText)) return clean(l.innerText); }
    const wrap = el.closest('label'); if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
    if (el.placeholder) return clean(el.placeholder);
    if (el.getAttribute('data-placeholder')) return clean(el.getAttribute('data-placeholder'));
    if (['BUTTON', 'A'].includes(el.tagName) || el.getAttribute('role')) { const t = clean(el.innerText || el.value || el.title); if (t) return t; }
    if (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type) && el.value) return clean(el.value);
    if (el.title) return clean(el.title);
    if (el.getAttribute('data-tooltip')) return clean(el.getAttribute('data-tooltip'));
    if (el.name) return clean(el.name.replace(/[_-]+/g, ' '));
    // nearest text before the field (common in older forms: "Name: [____]")
    let p = el.previousElementSibling; for (let i = 0; p && i < 3; i++, p = p.previousElementSibling) { const t = clean(p.innerText, 80); if (t) return t; }
    const parentText = clean(el.parentElement?.innerText, 80);
    return parentText || el.tagName.toLowerCase();
  }
  const ROLE_BUTTONS = { button: null, menuitem: 'menuitem', menuitemcheckbox: 'menuitem', menuitemradio: 'menuitem', tab: 'tab', option: 'option', switch: 'switch', treeitem: 'treeitem', combobox: 'combobox' };
  // the question a choice belongs to, so "3" becomes "How did you feel about your assignments?: 3"
  function questionOf(el) {
    const d = el.ownerDocument;
    const textOf = (n) => { if (!n) return ''; const by = n.getAttribute?.('aria-labelledby'); if (by) { const t = by.split(/\s+/).map((id) => d.getElementById(id)?.innerText || '').join(' '); if (clean(t)) return clean(t); } return clean(n.getAttribute?.('aria-label') || n.querySelector?.(':scope > legend')?.innerText || ''); };
    const g = el.closest('[role="radiogroup"], [role="group"], fieldset, [role="list"]');
    let q = textOf(g);
    // otherwise walk up to the question's card and use its heading (Google Forms puts options in their own lists)
    for (let item = el.closest('[role="listitem"], fieldset, .question, [data-question]'); !q && item; item = item.parentElement?.closest('[role="listitem"], fieldset, .question, [data-question]')) {
      q = clean(item.querySelector('[role="heading"], legend, h1, h2, h3, h4')?.innerText || '');
    }
    return clean(q, 120);
  }
  function fullLabel(el, kind) {
    const own = labelOf(el);
    if (kind !== 'radio' && kind !== 'checkbox') return own;
    const q = questionOf(el);
    return q && q !== own && !own.startsWith(q) ? `${q}: ${own}` : own;
  }
  const isChecked = (el) => (el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true');
  function kindOf(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return ['select'];
    if (tag === 'TEXTAREA') return ['textarea'];
    if (el.isContentEditable) return el.parentElement?.isContentEditable ? null : ['document']; // the editor's root only
    if (tag === 'A') return ['link'];
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (['hidden', 'password', 'file', 'image', 'range', 'color'].includes(t)) return null;
      if (t === 'checkbox') return ['checkbox'];
      if (t === 'radio') return ['radio'];
      if (['submit', 'button', 'reset'].includes(t)) return ['button'];
      return ['field'];
    }
    const role = el.getAttribute('role');
    if (role === 'radio') return ['radio'];
    if (role === 'checkbox') return ['checkbox'];
    if (tag === 'BUTTON') return ['button', ROLE_BUTTONS[role] || null];
    if (role === 'link') return ['link'];
    if (role in ROLE_BUTTONS) return ['button', ROLE_BUTTONS[role]];
    return null;
  }
  const isSearch = (el, label) => el.type === 'search' || ['searchbox', 'combobox'].includes(el.getAttribute('role')) || Boolean(el.closest('[role="search"], form[action*="search" i]')) || /\bsearch\b/i.test(`${label} ${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`);
  const opensSomething = (el) => { const h = el.getAttribute('aria-haspopup'); return (h && h !== 'false') || el.hasAttribute('aria-expanded') || el.getAttribute('role') === 'combobox'; };
  const PICK = 'input, textarea, select, button, a[href], [role="button"], [role="link"], [role^="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], [role="treeitem"], [role="combobox"], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
  // The page plus any panels from the SAME site shown inside it (Agent can work in those). Panels from other
  // sites are walled off by the browser: we only note that they're there, so Agent can say so.
  function pageDocs() {
    const docs = [document], walled = [];
    for (let i = 0; i < docs.length && docs.length < 8; i++) {
      for (const f of docs[i].querySelectorAll('iframe, frame')) {
        if (f.classList.contains('docs-texteventtarget-iframe') || !visible(f)) continue;
        const r = f.getBoundingClientRect(); if (r.width < 120 || r.height < 60) continue;
        let d = null; try { d = f.contentDocument; } catch { d = null; }
        if (d && d.body) docs.push(d);
        else if (walled.length < 5) { let h = ''; try { h = new URL(f.src, location.href).hostname; } catch {} walled.push({ label: clean(f.title || f.getAttribute('aria-label') || f.name || '', 80), host: h }); }
      }
    }
    return { docs, walled };
  }
  // ---- where things are, and the screenshot Agent looks at
  function pageRect(el) { // position on the screen, counting any panel (iframe) it sits in
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top, w = el.ownerDocument.defaultView;
    while (w && w !== window && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; }
    return { x, y, w: r.width, h: r.height };
  }
  const onScreen = (r) => r.x + r.w > 0 && r.y + r.h > 0 && r.x < innerWidth && r.y < innerHeight;
  function whereOf(el, r) {
    if (el.closest?.('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog')) return 'dialog';
    if (r.y < 110) return 'top';
    if (r.y > innerHeight - 90) return 'bottom';
    if (r.x + r.w < innerWidth * 0.22 || r.x > innerWidth * 0.78) return 'side';
    return 'main';
  }
  // password, card and ID-number boxes: blacked out on the picture before it leaves the computer
  function privateRects(docs) {
    const out = [];
    for (const d of docs) for (const el of d.querySelectorAll('input, textarea, [contenteditable="true"]')) {
      if (!visible(el)) continue;
      const hint = `${labelOf(el)} ${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`;
      if (el.type === 'password' || SENSITIVE.test(hint)) out.push(pageRect(el));
    }
    return out;
  }
  let shotTags = []; // [{ n: 12, r }] for the things on screen in the latest look
  const shotsOn = () => new Promise((res) => { try { chrome.storage.local.get('agentSettings', (v) => res(v?.agentSettings?.screenshots !== false)); } catch { res(false); } });
  // The tab as the employee sees it (the Agent bar stays put; Agent is told to ignore it), with a small numbered
  // tag on everything it can act on and private boxes blacked out. Made smaller so it's quick to send.
  async function screenshot() {
    const r = await send({ type: 'shot' });
    if (!r?.ok || typeof r.dataUrl !== 'string') return null;
    const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = r.dataUrl; });
    if (!img || !img.naturalWidth) return null;
    const W = Math.min(1024, img.naturalWidth), s = W / img.naturalWidth, H = Math.round(img.naturalHeight * s);
    const f = (img.naturalWidth / innerWidth) * s; // page pixels -> picture pixels
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    g.fillStyle = '#000';
    for (const b of privateRects(pageDocs().docs)) g.fillRect(b.x * f - 3, b.y * f - 3, b.w * f + 6, b.h * f + 6);
    const fs = Math.max(11, Math.round(12 * f)), th = fs + 3;
    g.font = `bold ${fs}px -apple-system, Segoe UI, Roboto, sans-serif`; g.textBaseline = 'top'; g.lineWidth = 1.5;
    for (const t of shotTags) {
      const x = t.r.x * f, y = t.r.y * f;
      g.strokeStyle = 'rgba(232, 28, 96, 0.9)'; g.strokeRect(x, y, t.r.w * f, t.r.h * f);
      const label = String(t.n), tw = g.measureText(label).width + 6;
      const lx = Math.max(0, Math.min(W - tw, x)), ly = y - th >= 0 ? y - th : y;
      g.fillStyle = 'rgba(232, 28, 96, 0.95)'; g.fillRect(lx, ly, tw, th);
      g.fillStyle = '#fff'; g.fillText(label, lx + 3, ly + 2);
    }
    let q = 0.5, url = c.toDataURL('image/jpeg', q);
    while (url.length > 1_500_000 && q > 0.3) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
    return url.length <= 1_900_000 ? url : null;
  }

  // When each thing first showed up, so a compose window or dialog that opened a minute ago still counts as NEW
  // on the next request (not only within one task).
  const firstSeen = new WeakMap();
  let watchStart = 0;
  const RECENT_MS = 3 * 60 * 1000;
  const words = (t) => [...new Set(String(t || '').toLowerCase().match(/[a-z]{4,}/g) || [])].filter((w) => !['this', 'that', 'with', 'from', 'about', 'please', 'could', 'would', 'make', 'write', 'have', 'into', 'your', 'some', 'what', 'there', 'their', 'then', 'them', 'also', 'like', 'just', 'tomorrows', 'tomorrow'].includes(w));
  // Which things matter most for THIS request. Everything still gets listed, but the bot sends only what fits,
  // so the useful things must come first: what just appeared, what's in a pop-up, anything you can type into,
  // what has focus, what matches the request's words, and what's on screen. Long lists of links come last.
  function score(el, item, ask) {
    let n = 0;
    if (item.fresh) n += 100;
    if (item.where === 'dialog') n += 60;
    if (['field', 'textarea', 'document', 'select'].includes(item.kind)) n += 50;
    const a = el.ownerDocument?.activeElement; if (a && (a === el || el.contains?.(a))) n += 40;
    const lab = String(item.label || '').toLowerCase();
    if (ask.some((w) => lab.includes(w))) n += 30;
    if (['checkbox', 'radio', 'button'].includes(item.kind)) n += 10;
    if (item.kind === 'link') n -= 10;
    n += item.offscreen ? -30 : 20;
    return n;
  }
  async function snapshot(round = 1, request = '') {
    refs.clear();
    const els = [];
    let n = 0, text = null;
    const { docs: allDocs, walled } = pageDocs();
    const inDocs = IN_DOCS && Boolean(docsTarget());
    if (IN_SLIDES && docsTarget()) { // Google Slides: slides in the strip, then the text boxes on this slide
      const deck = await slidesRead();
      const thumbs = slidesThumbs().slice(0, 40); const on = showingThumb(thumbs);
      thumbs.forEach((th, i) => { const id = `e${++n}`; refs.set(id, th); els.push({ id, kind: 'button', label: `Slide ${i + 1}${i === on ? ' (showing now)' : ''}`, role: 'tab' }); });
      for (const b of slidesBoxes().slice(0, 20)) {
        const id = `e${++n}`; refs.set(id, { slides: true, g: b.g });
        const empty = PLACEHOLDER.test(b.text);
        const isNotes = /speaker notes/i.test(b.text) || Boolean(b.g.closest('[class*="notes" i], [id*="notes" i]'));
        els.push({ id, kind: 'document', label: isNotes ? `Speaker notes (not on the slide) "${clean(b.text, 40)}"` : `Text box "${clean(b.text, 60)}"`, ...(empty ? { empty: true } : { value: mask(b.text).slice(0, 3000) }) });
      }
      // "Feeling around" spots: if a box isn't listed (Slides didn't draw it where we can read it), Agent can still
      // double-click where that box normally sits on the slide and type there, like feeling for it with a cane.
      if (slideCanvas()) for (const [spot, label] of [['title', 'Spot on the slide: title area (finds the box there)'], ['body', 'Spot on the slide: main text area (finds the box there)']]) {
        const id = `e${++n}`; refs.set(id, { probe: spot }); els.push({ id, kind: 'document', label });
      }
      text = deck == null ? null : mask(deck.replace(/\r/g, '').trim()).slice(0, 6000) || '(the presentation is empty)';
    }
    if (inDocs) { // Google Docs: the document first, then the menus and toolbar around it
      const t = await docsRead();
      const id = `e${++n}`; refs.set(id, DOCS);
      const item = { id, kind: 'document', label: 'Document' };
      if (t && norm(t)) { const st = bodyStyle(await docsParagraphStyles().catch(() => null)); if (st) item.style = st; }
      if (t != null) { if (norm(t)) item.value = mask(t.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()).slice(0, 3000); else item.empty = true; }
      els.push(item);
      text = t == null ? '(couldn’t read the document)' : mask(t.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()).slice(0, 6000) || '(the document is empty)';
    }
    const found = [];
    for (const el of allDocs.flatMap((d) => [...d.querySelectorAll(PICK)])) {
      if (found.length >= MAX_ELEMENTS * 3) break;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-hidden="true"], [inert]') || !visible(el)) continue;
      if (inDocs && el.closest('.kix-appview-editor')) continue; // the page itself is the "Document" above
      if (IN_SLIDES && el.closest('[class*="filmstrip"]')) continue; // listed above as "Slide N"
      const k = kindOf(el); if (!k) continue;
      const [kind, role] = k;
      const label = fullLabel(el, kind);
      const ac = el.getAttribute('autocomplete') || '';
      if (SENSITIVE.test(`${label} ${el.name || ''} ${el.id || ''} ${ac}`) && kind !== 'link' && kind !== 'button') continue; // never offered, never read
      const item = { kind, label: mask(label) };
      const rect = pageRect(el);
      item.where = whereOf(el, rect);
      if (!onScreen(rect)) item.offscreen = true;
      if (role) item.role = role;
      const now = Date.now();
      if (!firstSeen.has(el)) firstSeen.set(el, now);
      if (watchStart && firstSeen.get(el) > watchStart + 500 && now - firstSeen.get(el) < RECENT_MS) item.fresh = true; // appeared lately
      if (kind === 'button' && opensSomething(el)) item.popup = true;
      if (kind === 'field' && isSearch(el, label)) item.search = true;
      if (el.tagName === 'INPUT' && kind === 'field') item.type = (el.type || 'text').toLowerCase();
      if (kind === 'field' || kind === 'textarea') { if (el.value) item.value = mask(clean(el.value, 200)); }
      if (kind === 'document') { const t = el.innerText || ''; if (norm(t)) { item.value = mask(t.trim()).slice(0, 3000); const st = bodyStyle(richParagraphStyles(el)); if (st) item.style = st; } else item.empty = true; }
      if (kind === 'select') { item.options = [...el.options].map((o) => clean(o.text, 80)).filter(Boolean).slice(0, 60); const sel = el.selectedOptions[0]; if (sel && el.selectedIndex > 0) item.value = clean(sel.text, 80); }
      if (kind === 'checkbox' || kind === 'radio') item.checked = isChecked(el);
      if (el.required || el.getAttribute('aria-required') === 'true') item.required = true;
      found.push([el, item, rect]);
    }
    if (!watchStart) watchStart = Date.now();
    const ask = words(request);
    found.forEach((f) => { f[3] = score(f[0], f[1], ask); });
    found.sort((a, b) => b[3] - a[3]); // most useful first (stable for equal scores)
    // documents/slides listed above get a tag too
    shotTags = [];
    for (const it of els) {
      const ref = refs.get(it.id);
      const target = ref === DOCS ? document.querySelector('.kix-appview-editor, .kix-page-paginated, .kix-page') : ref?.slides ? ref.g : ref;
      if (target?.getBoundingClientRect) { const r = pageRect(target); if (onScreen(r)) shotTags.push({ n: Number(it.id.slice(1)), r }); }
    }
    // the employee's other tabs in this window, listed last: Agent can switch to one (new pages open by address)
    const tabsR = await send({ type: 'tabs' });
    const others = (Array.isArray(tabsR?.tabs) ? tabsR.tabs : []).filter((t) => !t.current).slice(0, 8);
    for (const [el, item, rect] of found.slice(0, Math.max(0, MAX_ELEMENTS - els.length - others.length))) {
      const id = `e${++n}`; refs.set(id, el); els.push({ id, ...item });
      if (!item.offscreen) shotTags.push({ n, r: rect });
    }
    for (const t of others) { const id = `e${++n}`; refs.set(id, { tabId: t.id }); els.push({ id, kind: 'tab', label: `Browser tab "${clean(t.title, 70)}" (${t.host})` }); }
    if (text == null) text = mask(clean(allDocs.map((d) => d.body?.innerText || '').join('\n'), 12000)).slice(0, 6000);
    return { url: location.href, title: clean(document.title, 200), text, elements: els, frames: walled };
  }

  // ------------------------------------------------------------------ doing a step (after approval)
  function refind(step) {
    if (!step.label || step.kind === 'document') return null;
    for (const d of pageDocs().docs) for (const el of d.querySelectorAll(PICK)) {
      if (el.disabled || !visible(el)) continue;
      const k = kindOf(el); if (!k || k[0] !== step.kind) continue;
      if (mask(fullLabel(el, k[0])) === step.label) return el;
    }
    return null;
  }
  const nativeSetter = (el) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  function fire(el, ...types) { for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true })); }
  async function doStep(step) {
    const el = refs.get(step.id);
    if (el === DOCS || (el && step.kind === 'document')) {
      return ['fill', 'insert', 'replace', 'clear', 'undo'].includes(step.do) ? editDo(step, el) : { ok: false, why: 'that doesn’t work in a document' };
    }
    if (!el || !el.isConnected) {
      const again = refind(step); // pages often rebuild a button or box while you type: find it again by its name
      if (!again) return { ok: false, why: 'it’s no longer on the page' };
      refs.set(step.id, again); return doStep(step);
    }
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    await sleep(150);
    flash(el);
    if (step.do === 'fill') {
      el.focus();
      const prev = el.value;
      const set = nativeSetter(el); // works with React/Vue-style forms too
      if (set) set.call(el, step.value); else el.value = step.value;
      fire(el, 'input', 'change');
      el.blur();
      if (el.value === String(step.value)) { runLog?.push({ field: el, prev }); return { ok: true }; }
      // some fields only take real typing: click in, select what's there, type it like a person
      if (await realAt(el, 'click')) {
        await realKeys([{ t: 'key', key: 'SelectAll' }, { t: 'key', key: 'Backspace' }, { t: 'type', text: String(step.value) }]);
        await sleep(200);
        if (el.value === String(step.value)) { runLog?.push({ field: el, prev }); return { ok: true }; }
      }
      return { ok: false, why: 'the field didn’t accept that value' };
    }
    if (step.do === 'submit') { // press Enter, like a person would; forms that ignore a synthetic Enter get submitted
      el.focus();
      const before = location.href, w = el.ownerDocument.defaultView;
      const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      const down = new w.KeyboardEvent('keydown', o); el.dispatchEvent(down);
      el.dispatchEvent(new w.KeyboardEvent('keypress', o)); el.dispatchEvent(new w.KeyboardEvent('keyup', o));
      await sleep(400);
      if (location.href === before && !down.defaultPrevented && el.form) { try { el.form.requestSubmit(); } catch { el.form.submit(); } }
      return { ok: true, unverified: true };
    }
    if (step.do === 'select') {
      const opt = [...el.options].find((o) => clean(o.text, 80).toLowerCase() === String(step.value).toLowerCase());
      if (!opt) return { ok: false, why: 'that option is gone' };
      const prev = el.value;
      const set = nativeSetter(el); if (set) set.call(el, opt.value); else el.value = opt.value;
      fire(el, 'input', 'change');
      if (el.value === opt.value) { runLog?.push({ field: el, prev }); return { ok: true }; }
      return { ok: false, why: 'the choice didn’t stick' };
    }
    if (step.do === 'check' || step.do === 'uncheck') {
      const want = step.do === 'check';
      if (isChecked(el) !== want) { if (el.tagName === 'INPUT') el.click(); else press(el); }
      await sleep(120);
      return isChecked(el) === want ? { ok: true } : { ok: false, why: 'it didn’t change' };
    }
    if (step.do === 'click') {
      const changes = watchChanges();
      if (['BUTTON', 'A', 'INPUT', 'LABEL'].includes(el.tagName)) el.click(); else press(el);
      if ((await changes) === 0 && el.isConnected) await realAt(el, 'click'); // nothing reacted: click it for real
      return { ok: true, unverified: true }; // a click can't be fully checked
    }
    return { ok: false, why: 'unknown step' };
  }

  // ------------------------------------------------------------------ the bar
  host = document.createElement('div');
  host.setAttribute('data-agent-bar', '');
  host.style.cssText = 'all: initial; position: fixed; inset: auto 0 0 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif; }
  .wrap { --accent: #3b5bdb; --fg: #16181d; --muted: #5d6270; --good: #2b8a3e; --bad: #c92a2a;
          --glass: rgba(255,255,255,.56); --edge: rgba(255,255,255,.8); --line: rgba(20,24,33,.10); --field: rgba(255,255,255,.55); --hover: rgba(255,255,255,.75); --bubble: rgba(255,255,255,.9);
          pointer-events: none; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 16px 18px; color: var(--fg); font-size: 14px; line-height: 1.45; }
  @media (prefers-color-scheme: dark) { .wrap { --accent: #8ea2ff; --fg: #eef0f4; --muted: #a5abb8; --good: #8ce99a; --bad: #ff8787;
          --glass: rgba(30,32,40,.62); --edge: rgba(255,255,255,.16); --line: rgba(255,255,255,.09); --field: rgba(255,255,255,.07); --hover: rgba(255,255,255,.11); --bubble: rgba(255,255,255,.13); } }
  .glass { pointer-events: auto; background: var(--glass); -webkit-backdrop-filter: blur(24px) saturate(170%); backdrop-filter: blur(24px) saturate(170%);
           border: 1px solid var(--edge); box-shadow: 0 12px 40px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.45); }
  .panel { width: min(720px, 100%); max-height: min(52vh, 460px); overflow: auto; border-radius: 22px; padding: 14px 16px; display: none; }
  .panel.on { display: block; }
  .panel.folded { display: none; }
  .fold { display: none; flex: none; } .fold.on { display: grid; place-items: center; }
  .fold svg { width: 18px; height: 18px; transition: transform .2s; } .fold[aria-expanded="false"] svg { transform: rotate(180deg); }
  .fold { position: relative; } .fold.news::after { content: ''; position: absolute; top: 4px; right: 4px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  @media (prefers-reduced-motion: reduce) { .fold svg { transition: none; } }
  .panel { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg) 25%, transparent) transparent; }
  .panel::-webkit-scrollbar { width: 8px; } .panel::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg) 22%, transparent); border-radius: 8px; }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .head b { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .icon-btn { border: 0; background: none; color: var(--muted); cursor: pointer; width: 28px; height: 28px; border-radius: 8px; font-size: 18px; line-height: 1; }
  .icon-btn:hover, .icon-btn:focus-visible { background: var(--hover); color: var(--fg); outline: none; }
  .feed { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 4px; }
  .msg { max-width: 82%; padding: 9px 14px; border-radius: 18px; overflow-wrap: anywhere; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .msg.you { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 6px; }
  .msg.agent { align-self: flex-start; background: var(--bubble); color: var(--fg); border-bottom-left-radius: 6px; }
  .msg.card { max-width: 92%; width: 92%; }
  .msg.bad { color: var(--bad); }
  .step-note { align-self: flex-start; padding: 0 6px; color: var(--muted); font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  .step-note.bad { color: var(--bad); }
  .say { margin: 0; }
  .say + .step-note, .say + .steps { margin-top: 8px; }
  .steps { list-style: none; margin: 0 0 10px; padding: 0; }
  .steps:last-child { margin-bottom: 0; }
  .steps li { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-top: 1px solid var(--line); }
  .steps li:first-child { border-top: 0; }
  .steps input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent); flex: none; }
  .what { flex: 1; min-width: 0; }
  .what small { display: block; color: var(--muted); }
  .what small.preview { white-space: pre-wrap; margin-top: 2px; }
  textarea.val { resize: vertical; line-height: 1.4; }
  .val { width: 100%; margin-top: 4px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 9px; background: var(--field); color: var(--fg); font: inherit; }
  .val:focus { outline: 2px solid var(--accent); border-color: transparent; }
  .mark { width: 18px; text-align: center; flex: none; font-weight: 700; }
  .mark.ok { color: var(--good); } .mark.no { color: var(--bad); }
  .btns { display: flex; gap: 8px; justify-content: flex-end; }
  .btn { border: 1px solid var(--line); background: var(--field); color: var(--fg); padding: 8px 14px; border-radius: 11px; font: 600 13px/1 inherit; cursor: pointer; }
  .btn:hover, .btn:focus-visible { background: var(--hover); outline: none; }
  .btn.primary { background: var(--accent); border-color: transparent; color: #fff; }
  .btn.undo { padding: 4px 10px; margin-left: 6px; font-size: 12px; vertical-align: middle; }
  .btn:disabled { opacity: .55; cursor: default; }
  .bad { color: var(--bad); }
  .bar { width: min(720px, 100%); display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 18px; }
  .bar input { flex: 1; min-width: 0; border: 0; background: none; color: var(--fg); font-size: 15px; padding: 8px 0; outline: none; }
  .bar input::placeholder { color: var(--muted); }
  .send { width: 36px; height: 36px; border-radius: 12px; border: 0; background: var(--accent); color: #fff; cursor: pointer; display: grid; place-items: center; flex: none; }
  .send:disabled { opacity: .5; cursor: default; }
  .send svg, .robot svg { width: 18px; height: 18px; }
  .robot { color: var(--accent); display: grid; place-items: center; flex: none; }
  .powered { pointer-events: none; font-size: 10.5px; color: var(--muted); margin-top: -4px; text-shadow: 0 1px 2px rgba(255,255,255,.4); }
  .cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; margin: -3px 0 0 -3px; pointer-events: none; opacity: 0; z-index: 3; transition: transform .38s cubic-bezier(.2,.8,.2,1), opacity .25s; filter: drop-shadow(0 2px 4px rgba(0,0,0,.35)); }
  .cursor.on { opacity: 1; }
  .ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid #2f6bff; pointer-events: none; animation: rip .5s ease-out forwards; }
  @keyframes rip { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .cursor { transition: opacity .2s; } .ripple { animation: none; opacity: 0; } }
  .hl { position: fixed; pointer-events: none; border: 2px solid var(--accent); border-radius: 8px; box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 25%, transparent); transition: opacity .4s; }
  @media (prefers-reduced-motion: reduce) { .hl { transition: none; } }
</style>
<div class="wrap" part="wrap">
  <div class="panel glass" role="log" aria-live="polite" aria-label="Agent">
    <div class="head"><b><span class="robot">${robotSvg()}</span><span class="title">Agent</span></b>
      <span><button class="icon-btn clear" type="button" title="Clear" aria-label="Clear conversation">⟲</button><button class="icon-btn close" type="button" title="Close (Esc)" aria-label="Close Agent">×</button></span></div>
    <div class="feed"></div>
  </div>
  <form class="bar glass" autocomplete="off">
    <span class="robot" aria-hidden="true">${robotSvg()}</span>
    <input class="ask" type="text" maxlength="1000" placeholder="Ask Agent to do something on this page…" aria-label="Ask Agent">
    <button class="icon-btn fold" type="button" aria-expanded="true" aria-label="Hide chat" title="Hide chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
    <button class="send" type="submit" aria-label="Send" title="Send (Enter)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
  </form>
  <div class="powered">Powered by co|op</div>
</div>`;
  function robotSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><circle cx="12" cy="2.6" r="1" fill="currentColor" stroke="none"/><rect x="4" y="6" width="16" height="13" rx="4"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><path d="M9.5 15.5h5"/><path d="M2 11v4M22 11v4"/></svg>';
  }

  const q = (s) => root.querySelector(s);
  const panel = q('.panel'), feed = q('.feed'), form = q('.bar'), ask = q('.ask'), sendBtn = q('.send');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const scrollDown = () => { panel.scrollTop = panel.scrollHeight; };
  const fold = q('.fold');
  function setOpen(open) {
    panel.classList.toggle('folded', !open);
    fold.setAttribute('aria-expanded', String(open));
    fold.setAttribute('aria-label', open ? 'Hide chat' : 'Show chat'); fold.title = open ? 'Hide chat' : 'Show chat';
    if (open) scrollDown();
  }
  // chat bubbles: "you" on the right, the agent on the left, small progress notes in between
  // Folding is the employee's choice: once they fold the chat it STAYS folded while Agent works. It only opens
  // again when they click the arrow, or when Agent needs them (an approval, or a problem they should look at).
  // While folded, the latest progress shows in the bar's text box so they can still see what's going on.
  let userFolded = false;
  let basePlaceholder = ask.placeholder;
  const showStatus = (text) => { if (userFolded && text) { ask.placeholder = clean(text, 90); fold.classList.add('news'); } };
  const openUp = () => { userFolded = false; ask.placeholder = basePlaceholder; fold.classList.remove('news'); setOpen(true); };
  const line = (kind, text) => {
    panel.classList.add('on'); fold.classList.add('on');
    if (kind === 'bad') openUp(); else if (!userFolded) setOpen(true); else showStatus(text);
    const cls = kind === 'you' ? 'msg you' : kind === 'step-note' ? 'step-note' : kind === 'bad' ? 'msg agent bad' : kind === 'card' ? 'msg agent card' : 'msg agent';
    const n = el('div', cls, text); feed.appendChild(n); scrollDown(); return n;
  };

  // branding: "<Company> Agent" and the company's accent color, if the workspace set one
  send({ type: 'status' }).then((s) => {
    if (s?.brand?.name) { const t = `${s.brand.name} Agent`; q('.title').textContent = t; basePlaceholder = `Ask ${t} to do something on this page…`; if (!userFolded) ask.placeholder = basePlaceholder; }
    if (s?.brand?.accent && /^#[0-9a-f]{6}$/i.test(s.brand.accent)) q('.wrap').style.setProperty('--accent', s.brand.accent);
  });

  // ---- the real mouse: a blue pointer you can watch, moving to where Agent clicks
  const MAC_P = /Mac/i.test(navigator.platform);
  let cursor = null, mouseNoted = false;
  async function realAt(target, kind = 'click') {
    let x, y;
    if (!target.nodeType && typeof target.x === 'number') { x = Math.round(target.x); y = Math.round(target.y); } // a spot on the screen
    else {
      const tr = target.querySelector?.('text')?.getBoundingClientRect ? pageRect(target.querySelector('text')) : pageRect(target);
      x = Math.round(tr.x + tr.w / 2); y = Math.round(tr.y + Math.min(tr.h / 2, 40));
    }
    if (!mouseNoted) { line('step-note', '› Using the mouse…'); mouseNoted = true; }
    if (!cursor) {
      cursor = el('div', 'cursor');
      cursor.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2.5l15 9.2-6.6 1.4-3.3 6.4z" fill="#2f6bff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      root.appendChild(cursor);
    }
    cursor.classList.add('on'); cursor.style.transform = `translate(${x}px, ${y}px)`;
    await sleep(420);
    const covered = document.elementFromPoint(x, y) === host; // the Agent bar is over that spot: step aside for a moment
    if (covered) host.style.visibility = 'hidden';
    const res = await send({ type: 'real', actions: [{ t: kind, x, y }], mac: MAC_P });
    if (covered) host.style.visibility = '';
    const rp = el('div', 'ripple'); Object.assign(rp.style, { left: `${x}px`, top: `${y}px` }); root.appendChild(rp); setTimeout(() => rp.remove(), 600);
    clearTimeout(realAt.t); realAt.t = setTimeout(() => cursor?.classList.remove('on'), 1500);
    return Boolean(res?.ok);
  }
  const realKeys = (actions) => send({ type: 'real', actions, mac: MAC_P }).then((r) => Boolean(r?.ok));
  // did anything on the page react to a click? (if not, the page probably ignored a simulated click)
  function watchChanges(ms = 600) {
    return new Promise((res) => {
      let n = 0; const mo = new MutationObserver((l) => { n += l.length; });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      setTimeout(() => { mo.disconnect(); res(n); }, ms);
    });
  }

  function flash(target) {
    const r = target.getBoundingClientRect();
    let x = r.left, y = r.top, w = target.ownerDocument.defaultView;
    while (w && w !== window && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; } // inside a panel
    const b = el('div', 'hl');
    Object.assign(b.style, { left: `${x - 4}px`, top: `${y - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    root.appendChild(b);
    setTimeout(() => { b.style.opacity = '0'; }, 700);
    setTimeout(() => b.remove(), 1200);
  }


  const DO_WORD = { fill: 'Fill', insert: 'Write in', submit: 'Press Enter in', select: 'Choose', check: 'Tick', uncheck: 'Untick', click: 'Click', switch: 'Go to', open: 'Go to' };
  let busy = false, stopped = false;
  let lastSig = '';
  let approvedTask = null; // the request the employee last approved (later rounds of it don't ask again)
  const RISKY = /\b(delete|remove|trash|discard|send|submit|pay|buy|purchase|order|checkout|publish|share|post|sign out|log ?out|unsubscribe|archive|transfer|confirm)\b/i;
  const risky = (st) => st.do === 'clear' || (st.do === 'replace' && !/click to add/i.test(st.label || '')) || (st.do === 'submit' && !/search/i.test(st.label || ''))
    || (st.do === 'click' && RISKY.test(st.label || ''));
  let history = []; // this chat only: what you typed and what Agent said, so follow-ups make sense
  // keep the employee's own messages (what the task IS); drop Agent's older notes first
  const remember = (who, text) => {
    if (!text) return;
    history = [...history, { who, text: String(text).slice(0, 300) }];
    while (history.length > 14) {
      const i = history.findIndex((h) => h.who === 'agent');
      history.splice(i === -1 || history.filter((h) => h.who === 'you').length > 6 ? 0 : i, 1);
    }
  };
  const stepName = (s) => (s.do === 'open' ? s.label : `${word(s)} “${s.label}”`);
  const word = (s) => (s.kind === 'document' ? { insert: s.swap ? 'Fill in a blank in' : 'Write at a spot in', fill: 'Add to', replace: 'Rewrite', clear: 'Clear', undo: s.value === 'all' ? 'Undo all my changes in' : 'Undo my last change in' }[s.do] || s.do : DO_WORD[s.do] || s.do);
  const styleNote = (st) => st && [st.font, st.size && `${st.size} pt`, st.spacing && st.spacing !== 'single' && `${st.spacing === 'double' ? 'Double' : '1.5'} spaced`, st.indent && 'Indented', st.align && st.align !== 'left' && `Aligned ${st.align}`].filter(Boolean).join(' · ');

  // "Run small tasks on their own" (popup setting, on unless turned off). The SERVER decides which plans are small.
  const autoOn = () => new Promise((res) => { try { chrome.storage.local.get('agentSettings', (v) => res(v?.agentSettings?.autoSmall !== false)); } catch { res(false); } });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const request = ask.value.trim();
    if (!request || busy) return;
    ask.value = ''; approvedTask = null; // a new message is a new task
    line('you', request);
    work(request, 1);
  });

  // one look at the page -> a plan -> (approval) -> do it -> look again if the task needs it
  async function work(request, round, opts = {}) {
    busy = true; sendBtn.disabled = true;
    const reading = line('step-note', round > 1 ? `› Looking at the page again (${round})…` : '› Reading the page…');
    const page = await snapshot(round, request);
    const doc = page.elements.find((x) => x.kind === 'document' && refs.get(x.id) === DOCS);
    const boxes = page.elements.filter((x) => x.kind === 'document' && refs.get(x.id)?.slides).length;
    reading.textContent = IN_SLIDES && docsTarget()
      ? `› Read the slides: ${boxes} text box${boxes === 1 ? '' : 'es'} on this slide, plus ${page.elements.length - boxes} slides, menus and buttons`
      : doc
      ? (doc.value || doc.empty ? `› Read the document: ${doc.empty ? 'empty' : `${norm(doc.value).split(' ').length} words`}, plus ${page.elements.length - 1} menus and buttons` : '› Opened the document (couldn’t read its text)')
      : `› ${round > 1 ? 'Looked again' : 'Read the page'}: ${page.elements.length} field${page.elements.length === 1 ? '' : 's'}, menus and buttons`;
    showStatus(reading.textContent);
    const shot = (await shotsOn()) ? await screenshot().catch(() => null) : null;
    const thinking = line('step-note', '› Thinking…');
    const r = await send({ type: 'plan', request, page, history, round, ...(shot ? { screenshot: shot } : {}), ...(opts.failure ? { failure: opts.failure } : {}) });
    if (r?.ok && r.body?.saw) reading.textContent += ' (and looked at the screen)';
    if (round === 1) remember('you', request);
    thinking.remove();
    busy = false; sendBtn.disabled = false;
    if (!r?.ok) { const m = r?.message || 'Something went wrong. Nothing was changed.'; line('bad', m); remember('agent', m); ask.focus(); return; }
    showPlan(r.body || {}, page.url, request, round, opts.tries || 0);
  }

  async function showPlan(plan, url, request, round, tries = 0) {
    let steps = Array.isArray(plan.steps) ? plan.steps : [];
    if (steps.length > 1) steps = steps.filter((st) => !(st.do === 'click' && /\(showing now\)/.test(st.label || ''))); // already there
    // the same steps as the round before = nothing new to do (stops a task from going round in circles)
    const cut0 = steps.findIndex((st, i) => st.do === 'click' && i < steps.length - 1);
    const sig = JSON.stringify(steps.slice(0, cut0 === -1 ? steps.length : cut0 + 1).map((x) => [x.do, x.label, x.value]));
    if (round > 1 && steps.length && sig === lastSig) { steps = []; plan = { ...plan, steps, say: 'I seem to be going in circles, so I stopped here. Tell me what to do next.', more: false }; }
    lastSig = sig;
    // After a click the screen may change (a new slide, a dialog), so steps planned past it would aim at things
    // that are gone. Do the click, then look again. (Opening a menu and picking from it is fine in one go.)
    const moves = (st) => st.do === 'open' || st.do === 'switch';
    const cut = steps.findIndex((st, i) => i < steps.length - 1 && (moves(st) || (st.do === 'click' && !(steps[i + 1]?.do === 'click' && refs.get(st.id)?.getAttribute?.('aria-haspopup')))));
    if (cut !== -1 && round < 10) { steps = steps.slice(0, cut + 1); plan = { ...plan, steps, more: true, auto: plan.auto === true && steps.length > 0 }; }
    else if (steps.length && (steps[steps.length - 1].do === 'click' || moves(steps[steps.length - 1])) && round < 10) plan = { ...plan, more: true }; // a click at the end: look again
    const card = line(steps.length ? 'card' : 'agent');
    const sayText = plan.say || (steps.length ? 'Here’s what I’d do:' : round > 1 ? 'That’s everything for this task.' : 'I couldn’t find anything to do on this page for that.');
    card.appendChild(el('p', 'say', sayText)); remember('agent', sayText); showStatus(sayText);
    if (plan.warning) card.appendChild(el('p', /math/i.test(plan.warning) ? 'step-note bad' : 'step-note', plan.warning));
    if (!steps.length) { ask.focus(); return; }
    // You approved this task already: the next rounds of the SAME task carry on without asking again, unless a
    // step could lose or send something (deleting, sending, paying, rewriting text that's there).
    const carryOn = round > 1 && approvedTask === request && !steps.some(risky);
    const auto = (plan.auto === true && await autoOn()) || carryOn;
    const list = el('ul', 'steps');
    const rows = steps.map((s, i) => {
      const li = el('li');
      const box = el('input'); box.type = 'checkbox'; box.checked = true; box.setAttribute('aria-label', `Include step ${i + 1}`);
      if (auto) box.hidden = true;
      const what = el('div', 'what');
      what.appendChild(el('span', null, s.do === 'open' ? s.label : `${word(s)} “${s.label}”`));
      let val = null;
      if ((s.do === 'fill' || s.do === 'replace') && !auto) {
        const long = s.kind === 'document' || s.kind === 'textarea' || /\n/.test(s.value || '');
        val = el(long ? 'textarea' : 'input', 'val'); val.value = s.value || ''; val.setAttribute('aria-label', `Value for ${s.label}`);
        if (long) val.rows = Math.min(10, Math.max(2, String(s.value || '').split('\n').length + 1));
        what.appendChild(val);
      } else if (s.value && s.do !== 'undo' && s.do !== 'open') what.appendChild(el('small', 'preview', s.value.length > 160 ? `${s.value.slice(0, 160)}…` : s.value));
      if (s.do === 'insert') what.appendChild(el('small', null, s.swap ? `in place of “${clean(s.find, 60)}”` : `right after “${clean(s.find, 60)}”`));
      const note = styleNote(s.style); if (note) what.appendChild(el('small', null, note));
      const mark = el('span', 'mark', '');
      li.append(box, what, mark);
      list.appendChild(li);
      return { s, box, val, mark };
    });
    card.appendChild(list);
    const next = { more: plan.more === true, request, round, tries };
    if (auto) { card.appendChild(el('p', 'step-note', carryOn && plan.auto !== true ? '› Part of the task you approved, so it carried on.' : '› Small task, so it ran on its own.')); await run(rows, null, url, true, rows, next); return; }

    const btns = el('div', 'btns');
    const cancel = el('button', 'btn', 'Deny'); cancel.type = 'button';
    const go = el('button', 'btn primary', `Approve ${steps.length} step${steps.length === 1 ? '' : 's'}`); go.type = 'button';
    btns.append(cancel, go); card.appendChild(btns);
    openUp(); // needs the employee: open the chat even if they folded it
    const count = () => { const n = rows.filter((r) => r.box.checked).length; go.textContent = `Approve ${n} step${n === 1 ? '' : 's'}`; go.disabled = n === 0; };
    rows.forEach((r) => r.box.addEventListener('change', count));
    scrollDown();
    cancel.addEventListener('click', () => {
      btns.remove(); approvedTask = null; rows.forEach((r) => { r.box.disabled = true; if (r.val) r.val.disabled = true; });
      line('step-note', '› Denied. Nothing was changed.'); remember('agent', 'The employee denied that plan. Nothing was changed.');
      send({ type: 'log', url, outcome: 'cancelled', done: 0, total: steps.length, denied: true, request, steps: rows.map((r) => ({ what: stepName(r.s), ok: false })) });
      ask.focus();
    }, { once: true });
    go.addEventListener('click', async () => {
      cancel.remove(); approvedTask = request;
      go.textContent = 'Stop'; go.classList.remove('primary');
      go.addEventListener('click', () => { stopped = true; go.disabled = true; go.textContent = 'Stopping…'; }, { once: true });
      await run(rows.filter((r) => r.box.checked), btns, url, false, rows, next);
    }, { once: true });
  }

  async function run(chosen, btns, url, auto, all, next) {
    all.forEach((r) => { r.box.disabled = true; if (r.val) r.val.disabled = true; });
    stopped = false; busy = true; sendBtn.disabled = true; mouseNoted = false;
    const entries = []; runLog = entries;
    let done = 0, unchecked = 0, uncheckedWrites = 0, moved = false; const problems = [];
    for (const r of chosen) {
      if (stopped) break;
      const step = { ...r.s, ...(r.val ? { value: r.val.value } : {}) };
      r.mark.textContent = '…'; showStatus(`› ${word(r.s)} “${r.s.label}”…`);
      let res;
      if (step.do === 'open' || step.do === 'switch') { // the task carries on in the other tab
        const carry = { request: next?.request, round: (next?.round || 1) + 1, tries: 0, history, approvedTask: approvedTask || (auto ? null : next?.request) };
        await saveNow();
        res = await send({ type: 'goTab', url: step.do === 'open' ? step.value : '', tabId: step.do === 'switch' ? refs.get(step.id)?.tabId : null, carry: next?.more ? carry : null });
        if (res?.ok) { r.mark.textContent = '✓'; r.mark.className = 'mark ok'; moved = true; done++; break; }
        res = { ok: false, why: res?.message || 'that tab couldn’t be opened' };
      } else {
      try { res = await doStep(step); } catch { res = { ok: false, why: 'the page blocked it' }; }
      }
      r.mark.textContent = res.ok ? (res.unverified ? '•' : '✓') : '✗'; r.mark.className = `mark ${res.ok ? 'ok' : 'no'}`;
      r.mark.title = res.ok ? (res.unverified ? 'Done, but I couldn’t double-check it' : 'Done and checked') : 'Didn’t work';
      if (res.ok && res.unverified) { unchecked++; if (step.do !== 'click') uncheckedWrites++; } // a click can't be checked; opening menus is normal
      if (res.ok) done++; else { problems.push(`${word(step)} “${step.label}”: ${res.why}`); if (step.do === 'click' || step.kind === 'document') break; }
      await sleep(220);
    }
    runLog = null;
    if (entries.length) undoRuns.push(entries);
    btns?.remove();
    const total = chosen.length;
    const outcome = done === total ? 'done' : stopped ? 'cancelled' : done ? 'partial' : 'failed';
    // for the office's activity list: what was asked and each step's name + whether it worked (never the values)
    send({ type: 'log', url, outcome, done, total, auto, request: next?.request || '', steps: chosen.map((r) => ({ what: stepName(r.s), ok: r.mark.textContent === '✓' || r.mark.textContent === '•' })) });
    remember('agent', `Did: ${chosen.slice(0, done).map((r) => `${word(r.s)} “${r.s.label}”`).join(', ') || 'nothing'}.`);
    busy = false; sendBtn.disabled = false;
    if (moved) { // the other tab has the chat now and carries on there
      line('step-note', next?.more ? '› Carrying on in the other tab…' : '› Switched tabs.');
      await saveNow();
      return;
    }
    // more to do (a menu opened, a dialog appeared): look again and carry on
    if (next?.more && outcome === 'done' && !uncheckedWrites) { await sleep(500); return work(next.request, next.round + 1, { tries: next.tries }); }
    // it didn't work: tell the AI what went wrong and let it try another way (twice at most, same approval rules)
    if (problems.length && !stopped && next && next.tries < 2) {
      const why = problems.join('; ');
      line('step-note', `› That didn’t work. Trying another way…`);
      lastSig = ''; // trying again may rightly repeat the same steps
      remember('agent', `That didn’t work: ${why}`);
      await sleep(400);
      return work(next.request, next.round + 1, { failure: why, tries: next.tries + 1 });
    }
    const paused = next?.more && outcome === 'done' && uncheckedWrites; // couldn't confirm the last steps: check before going on
    const result = problems.length
      ? `Done ${done} of ${total}. ${problems.join('; ')}. Please check the page.`
      : stopped ? `Stopped after ${done} of ${total} steps.`
      : paused ? `Done: ${done} of ${total}. I couldn’t double-check ${unchecked === total ? 'it' : `${unchecked} of them`}, so I stopped here. Check the page, then tell me to keep going.`
      : unchecked ? `Done: ${done} of ${total} step${total === 1 ? '' : 's'}. I couldn’t double-check ${unchecked === total ? 'it' : `${unchecked} of them`}, so take a quick look.`
      : `Done and checked: ${done} of ${total} step${total === 1 ? '' : 's'}.`;
    const bubble = line(problems.length ? 'bad' : 'agent', result); remember('agent', result);
    if (entries.length) addUndo(bubble, entries);
    ask.focus();
  }

  // an "Undo" button on the latest change Agent made (older ones go away once something newer happens)
  function addUndo(bubble, entries) {
    const b = el('button', 'btn undo', 'Undo'); b.type = 'button';
    b.dataset.undo = '1'; b.__entries = entries;
    bubble.append(' ', b);
    refreshUndoButtons();
    b.addEventListener('click', async () => {
      if (busy) return;
      b.disabled = true; b.textContent = 'Undoing…'; busy = true;
      const res = await undoSome('last');
      busy = false;
      b.remove();
      const m = res.ok ? (res.unverified ? 'Undone. I couldn’t double-check it, so take a quick look.' : 'Undone and checked: it’s back the way it was.') : `Couldn’t undo: ${res.why}.`;
      line(res.ok ? 'agent' : 'bad', m); remember('agent', m);
    }, { once: true });
  }
  function refreshUndoButtons() {
    const latest = undoRuns[undoRuns.length - 1];
    feed.querySelectorAll('[data-undo]').forEach((b) => { if (b.__entries !== latest) b.remove(); });
  }

  // ---- one chat across tabs. The conversation is kept by the extension (for this browser window, until the
  // browser closes), so when Agent moves to another tab, or the employee does, the bar comes along with it.
  const plainText = (n) => { const c = n.cloneNode(true); c.querySelectorAll('button').forEach((b) => b.remove()); return c.textContent.trim(); };
  const serialize = () => [...feed.children].slice(-40).map((n) => {
    const c = n.className || '';
    if (c.includes('card')) return { k: 'card', say: n.querySelector('.say')?.textContent || '', steps: [...n.querySelectorAll('.steps li')].map((li) => [li.querySelector('.what span')?.textContent || '', li.querySelector('.mark')?.textContent || '']), note: [...n.children].filter((x) => x.classList.contains('step-note')).map((x) => x.textContent).join(' ') };
    return { k: c.includes('msg you') ? 'you' : c.includes('bad') ? 'bad' : c.includes('step-note') ? 'note' : 'agent', t: plainText(n) };
  });
  function restore(items) {
    feed.textContent = '';
    for (const it of items) {
      if (it.k === 'card') {
        const card = el('div', 'msg agent card'); card.appendChild(el('p', 'say', it.say));
        if (it.steps?.length) { const ul = el('ul', 'steps'); for (const [label, mark] of it.steps) { const li = el('li'); const w = el('div', 'what'); w.appendChild(el('span', null, label)); li.append(w, el('span', `mark ${mark === '✗' ? 'no' : mark ? 'ok' : ''}`, mark)); ul.appendChild(li); } card.appendChild(ul); }
        if (it.note) card.appendChild(el('p', 'step-note', it.note));
        feed.appendChild(card);
      } else feed.appendChild(el('div', it.k === 'you' ? 'msg you' : it.k === 'bad' ? 'msg agent bad' : it.k === 'note' ? 'step-note' : 'msg agent', it.t));
    }
    if (items.length) { panel.classList.add('on'); fold.classList.add('on'); }
    scrollDown();
  }
  let chatOn = true; // false once the employee closes the bar: then it stops following them around
  const saveNow = () => (chatOn ? send({ type: 'convoSave', convo: { items: serialize(), history, approvedTask, folded: userFolded } }) : Promise.resolve());
  let saveT = null;
  new MutationObserver(() => { clearTimeout(saveT); saveT = setTimeout(saveNow, 400); }).observe(feed, { childList: true, subtree: true, characterData: true });
  async function boot() {
    const b = await send({ type: 'boot' });
    if (b?.convo && !busy) {
      chatOn = true;
      restore(Array.isArray(b.convo.items) ? b.convo.items : []);
      history = Array.isArray(b.convo.history) ? b.convo.history : [];
      approvedTask = b.convo.approvedTask || null;
      if (b.convo.folded && !b.pending) { userFolded = true; setOpen(false); } else if (b.convo.items?.length) setOpen(true);
    }
    if (b?.pending && !busy) { // Agent moved here in the middle of a task: carry on
      const p = b.pending;
      if (!b.convo && Array.isArray(p.history)) history = p.history;
      approvedTask = p.approvedTask || null; lastSig = '';
      line('step-note', '› Picked up here in this tab…');
      await sleep(600); // let the page settle
      work(String(p.request || ''), Number(p.round) || 2, { tries: 0 });
    }
  }

  q('.close').addEventListener('click', () => { chatOn = false; send({ type: 'convoEnd' }); toggle(false); });
  q('.clear').addEventListener('click', () => { feed.textContent = ''; history = []; undoRuns = []; approvedTask = null; panel.classList.remove('on'); fold.classList.remove('on'); openUp(); ask.focus(); saveNow(); });
  fold.addEventListener('click', () => { if (panel.classList.contains('folded')) openUp(); else { userFolded = true; setOpen(false); } });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); toggle(false); } });
  // keep the page's own keyboard shortcuts from firing while typing in the bar
  ['keydown', 'keyup', 'keypress'].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()));
  // ...and keep clicks in the bar from closing the page's open menus (so multi-step tasks can carry on)
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'focusin'].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()));

  function toggle(force) {
    const show = typeof force === 'boolean' ? force : host.style.display === 'none';
    host.style.display = show ? '' : 'none';
    if (show) setTimeout(() => ask.focus(), 0);
  }
  // shown again by the extension (Agent moved here, or the employee switched to this tab)
  const resume = () => { chatOn = true; toggle(true); if (!busy) boot(); };
  window.__agentBar = { toggle: (f) => { if (f !== false && host.style.display === 'none') { chatOn = true; } toggle(f); }, resume };
  (document.body || document.documentElement).appendChild(host);
  setTimeout(() => ask.focus(), 0);
  boot();
})();
