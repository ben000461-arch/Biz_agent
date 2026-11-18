// apply-phase3d.mjs — makes the bot's model log line say WHY a hosted model was skipped (for example "http 429: rate limit").
// Needs the new llm.js in this folder.   node apply-phase3d.mjs
import fs from 'node:fs';
const file = process.argv[2] || 'server.js';
let src = fs.readFileSync(file, 'utf8');
if (src.includes('r.failures')) { console.log('Already applied. Nothing changed.'); process.exit(0); }
const find = "${r.degraded ? ` FALLBACK from ${r.firstChoice}` : ''}";
const n = src.split(find).length - 1;
if (n !== 1) { console.log(`Nothing changed: expected 1 match, found ${n}. Send me the [llm] console.log line in server.js.`); process.exit(1); }
src = src.replace(find, () => "${r.degraded ? ` FALLBACK from ${r.firstChoice} (${(r.failures || []).slice(0, 2).join('; ')})` : ''}");
fs.copyFileSync(file, `${file}.bak-phase3d`);
fs.writeFileSync(file, src);
console.log(`Done. Saved your old file as ${file}.bak-phase3d (restore with: cp ${file}.bak-phase3d ${file}).`);
