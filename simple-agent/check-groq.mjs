// Tests a Groq key straight from this computer. The key is typed hidden and never printed or saved.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl._writeToOutput = (s) => { if (s.includes('\n') || s.includes('Groq key')) process.stdout.write(s); };
rl.question('Paste your Groq key (nothing will show), then press Enter: ', async (answer) => {
  rl.close();
  const key = answer.replace(/[^\x21-\x7E]/g, '');
  console.log(`\nReceived ${answer.length} characters, ${key.length} usable. Starts with "${key.slice(0, 4)}".`);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'biz-agent/1.0' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 5, messages: [{ role: 'user', content: 'Say hi' }] }),
    });
    const body = await res.text();
    let code = '';
    try { const j = JSON.parse(body); code = j?.error?.code || j?.error?.type || j?.choices?.[0]?.message?.content || ''; } catch { code = body.slice(0, 80).replace(/\s+/g, ' '); }
    console.log(`Groq answered: status ${res.status}${code ? ' - ' + String(code).slice(0, 80) : ''}`);
    console.log(res.ok ? 'The key works.' : 'Groq did not accept it (see the status above).');
  } catch (e) {
    console.log('Could not reach Groq from this computer:', e.cause?.code || e.message);
  }
});
