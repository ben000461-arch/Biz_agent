// friend-agent — shared in-memory state: the live activity log the dashboard
// polls, and the "extra instructions" your friend can edit from the dashboard.
//
// Deliberately simple: a plain array and a plain string, both in memory only.
// Restarting the server clears both. That's the right amount of persistence
// for a personal single-user tool — a real database would be solving a
// problem this project doesn't have yet.

const MAX_ENTRIES = 100;
const log = [];

// type is a short tag ('sms-in', 'issue-created', 'issue-failed', 'ignored',
// 'pr-opened', 'pr-merged', 'checks-failed', 'webhook-rejected') so the
// dashboard can color/group entries. detail is a short human string.
export function logEvent(type, detail) {
  log.unshift({ time: new Date().toISOString(), type, detail });
  if (log.length > MAX_ENTRIES) log.length = MAX_ENTRIES;
}

export function getLog() {
  return log;
}

let agentInstructions = '';

export function getAgentInstructions() {
  return agentInstructions;
}

export function setAgentInstructions(text) {
  agentInstructions = (text || '').slice(0, 2000); // keep it bounded — this gets pasted into a prompt
}