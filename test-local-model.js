// test-local-model.js
//
// Standalone test — does NOT touch simple-agent/server.js.
// Sends the exact same classification prompt simple-agent uses to your local
// Ollama server, against whichever models you list below, with a batch of
// realistic test messages. Prints how long each one took and whether it came
// back as valid, correct JSON — so we can compare models side by side before
// wiring anything into the real bot.
//
// Run with: node test-local-model.js
// (requires `ollama serve` running in another tab, same as always)

const MODELS_TO_TEST = ['llama3.2:3b', 'llama3.1:8b']; // edit this list anytime

const SYSTEM_PROMPT = `You read a short message and decide which of these actions it's requesting:
- "add": add two numbers. Extract "a" and "b".
- "multiply": multiply two numbers. Extract "a" and "b".
- "weather": look up current weather somewhere. Extract "location" (a city/place name).
- "add_note": remember something for later, ONLY when no file/document is mentioned. Extract "note" (the text to save).
- "list_notes": show all saved notes. No extra fields needed.
- "write_file": use this whenever the message mentions a FILE, a .txt, a document, or saving/creating something on the Desktop or computer — even if the wording is close to a note. Extract "filename" (invent a short one ending in .txt if none is given) and "file_content" (the text to put in it).
- "draft_email": the message asks to draft/write an email. Write a real, well-written "email_subject" and "email_body" yourself based on what's asked (professional tone, appropriate length). Extract "recipient" too if a name/email is mentioned, otherwise null.
- "write_excel": the message asks to CREATE a brand-new spreadsheet from scratch. Build "sheet_rows" as a 2D array of arrays (each inner array is one row of cells, include a header row as the first row if it makes sense) representing the data described. Extract "filename" (invent one ending in .xlsx if none given).
- "edit_excel": the message asks to CHANGE, UPDATE, or ADD TO an EXISTING spreadsheet (mentions an existing filename, or says "add to", "update", "edit" a spreadsheet). Extract "filename" (the existing file's name, guess ".xlsx" extension if not given).
- "unknown": anything that isn't clearly one of the above.
Rule: if the word "file" appears, or a filename like "todo.txt" is mentioned, ALWAYS choose "write_file", never "add_note".
Rule: if the message is about an EXISTING spreadsheet (updating/adding to one), choose "edit_excel", not "write_excel".
Respond ONLY with valid JSON: {"action": "add"|"multiply"|"weather"|"add_note"|"list_notes"|"write_file"|"draft_email"|"write_excel"|"edit_excel"|"unknown", "a": number|null, "b": number|null, "location": string|null, "note": string|null, "filename": string|null, "file_content": string|null, "recipient": string|null, "email_subject": string|null, "email_body": string|null, "sheet_rows": array|null}`;

// Each test case: the message, and which action we EXPECT back (so we can
// auto-grade correctness, not just "did it return JSON").
const TEST_CASES = [
  { text: 'add 7 and 15', expect: 'add' },
  { text: 'what is 12 times 6', expect: 'multiply' },
  { text: 'weather in Corona', expect: 'weather' },
  { text: 'remember that I need to call the dentist', expect: 'add_note' },
  { text: 'show me my notes', expect: 'list_notes' },
  { text: 'make a file called todo.txt that says pick up milk and call the dentist', expect: 'write_file' },
  { text: 'draft an email to John about rescheduling Friday', expect: 'draft_email' },
  { text: 'make a spreadsheet of my expenses: rent 1200, food 300', expect: 'write_excel' },
  { text: 'update the price of bread in inventory.xlsx to 3.00', expect: 'edit_excel' },
  { text: 'add oranges to inventory.xlsx, quantity 40, price 0.75', expect: 'edit_excel' },
  { text: 'asdkjalksjd random gibberish', expect: 'unknown' },
];

async function callOllama(model, userText) {
  const start = Date.now();
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
      format: 'json',
      stream: false,
      options: { temperature: 0 },
    }),
  });
  const elapsed = Date.now() - start;

  if (!res.ok) {
    return { elapsed, error: `HTTP ${res.status}: ${await res.text()}` };
  }
  const data = await res.json();
  let parsed;
  try {
    parsed = JSON.parse(data.message.content);
  } catch (e) {
    return { elapsed, error: `Not valid JSON: ${data.message.content}` };
  }
  return { elapsed, parsed };
}

async function run() {
  for (const model of MODELS_TO_TEST) {
    console.log(`\n========== ${model} ==========`);
    let correct = 0;
    let totalMs = 0;

    for (const { text, expect } of TEST_CASES) {
      const result = await callOllama(model, text);
      totalMs += result.elapsed;

      if (result.error) {
        console.log(`[FAIL]  "${text}"\n        -> ${result.error}  (${result.elapsed}ms)`);
        continue;
      }

      const got = result.parsed.action;
      const ok = got === expect;
      if (ok) correct++;
      console.log(
        `[${ok ? ' OK ' : 'WRONG'}] "${text}"\n        -> expected "${expect}", got "${got}"  (${result.elapsed}ms)`
      );
    }

    console.log(`\n${model}: ${correct}/${TEST_CASES.length} correct, avg ${Math.round(totalMs / TEST_CASES.length)}ms per message`);
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
