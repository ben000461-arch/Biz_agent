const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function render() {
  const s = await send({ type: 'status' });
  if (s?.brand?.name) $('name').textContent = `${s.brand.name} Agent`;
  $('signed-in').hidden = !s?.signedIn;
  $('signed-out').hidden = Boolean(s?.signedIn);
  if (s?.signedIn) $('who').textContent = s.email || 'your account';
  else $('email').focus();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('go').disabled = true; $('msg').hidden = true;
  const r = await send({ type: 'signIn', email: $('email').value, password: $('password').value });
  $('go').disabled = false; $('password').value = '';
  if (!r?.ok) { $('msg').textContent = r?.message || 'Couldn’t sign in.'; $('msg').hidden = false; return; }
  render();
});

$('open').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = tab ? await send({ type: 'open', tabId: tab.id }) : { ok: false, message: 'No page is open.' };
  if (r?.ok) window.close();
  else { $('msg2').textContent = r?.message || 'Agent can’t open here.'; $('msg2').hidden = false; }
});

// "Run small tasks on their own": on unless turned off. Kept next to the other Agent settings.
const AUTO_ON = 'Typing, filling and opening menus run right away. Other clicks, deleting and rewriting still ask you.';
const AUTO_OFF = 'Off: every step waits for you to approve it.';
chrome.storage.local.get('agentSettings', (v) => { const on = v?.agentSettings?.autoSmall !== false; $('auto').checked = on; $('auto-note').textContent = on ? AUTO_ON : AUTO_OFF; });
$('auto').addEventListener('change', () => {
  const on = $('auto').checked;
  $('auto-note').textContent = on ? AUTO_ON : AUTO_OFF;
  chrome.storage.local.get('agentSettings', (v) => chrome.storage.local.set({ agentSettings: { ...(v?.agentSettings || {}), autoSmall: on } }));
});

// "Let Agent see the screen": on unless turned off
const SHOT_ON = 'A picture of this tab helps Agent find the right spot. Private fields are blacked out, and nothing is saved.';
const SHOT_OFF = 'Off: Agent only reads the page, it doesn’t look at it.';
chrome.storage.local.get('agentSettings', (v) => { const on = v?.agentSettings?.screenshots !== false; $('shots').checked = on; $('shot-note').textContent = on ? SHOT_ON : SHOT_OFF; });
$('shots').addEventListener('change', () => {
  const on = $('shots').checked;
  $('shot-note').textContent = on ? SHOT_ON : SHOT_OFF;
  chrome.storage.local.get('agentSettings', (v) => chrome.storage.local.set({ agentSettings: { ...(v?.agentSettings || {}), screenshots: on } }));
});

$('out').addEventListener('click', async () => { await send({ type: 'signOut' }); render(); });

render();
