// Lists the models your Groq key can use. The key is typed hidden and never printed or saved.
// The key is typed hidden and is never printed or saved.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl._writeToOutput = (s) => { if (s.includes('\n') || s.includes('Groq key')) process.stdout.write(s); };
rl.question('Paste your Groq key (nothing will show), then press Enter: ', async (answer) => {
  rl.close();
  const key = answer.replace(/[^\x21-\x7E]/g, '');
  console.log(`\nReceived ${answer.length} characters, ${key.length} usable. Starts with "${key.slice(0, 4)}".`);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}`, 'user-agent': 'biz-agent/1.0' },
    });
    const body = await res.text();
    let j = {};
    try { j = JSON.parse(body); } catch {}
    console.log(`Groq answered: status ${res.status}`);
    if (res.ok && Array.isArray(j.data)) {
      const ids = j.data.map((m) => m.id).filter((id) => !/whisper|tts|guard|distil/i.test(id)).sort();
      console.log('The key works. Models you can use for chat/coding:');
      for (const id of ids) console.log('  ' + id);
    } else {
      console.log('Groq did not accept it:', String(j?.error?.code || j?.error?.type || '').slice(0, 80));
    }
  } catch (e) {
    console.log('Could not reach Groq from this computer:', e.cause?.code || e.message);
  }
});
