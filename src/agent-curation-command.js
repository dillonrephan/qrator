import { normalizeCurationBrief, validateCurationProposal } from './agent-curation.js';
import { normalizeProviderSnapshot } from './agent-snapshot.js';

export function runCurationCommand(command, input) {
  if (!['brief', 'snapshot', 'validate'].includes(command)) {
    throw new Error('Usage: qrator-curate <brief|snapshot|validate> < request.json');
  }

  let document;
  try {
    document = JSON.parse(input);
  } catch {
    throw new Error('Curation input must be valid JSON.');
  }

  if (command === 'brief') return normalizeCurationBrief(document);
  if (command === 'snapshot') return normalizeProviderSnapshot(document);
  return validateCurationProposal(document);
}
