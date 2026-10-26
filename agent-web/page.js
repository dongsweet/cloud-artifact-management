import { readFileSync } from 'node:fs';

// Compatibility helper for source-level tests and tooling. The runtime serves
// the checked-in static index.html directly; this module no longer assembles it.
const source = new URL('./index.html', import.meta.url);

export function agentPage() {
  return readFileSync(source, 'utf8');
}
