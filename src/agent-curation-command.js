import { normalizeCurationBrief } from './agent-curation.js';
import { normalizeProviderSnapshot } from './agent-snapshot.js';

export function runCurationCommand(command, input, options = {}) {
  if (!['brief', 'snapshot', 'harvest', 'validate', 'publish'].includes(command)) {
    throw new Error('Usage: qrator-curate <brief|snapshot|harvest|validate|publish> < request.json');
  }

  let document;
  try {
    document = JSON.parse(input);
  } catch {
    throw new Error('Curation input must be valid JSON.');
  }

  if (command === 'brief') return normalizeCurationBrief(document);
  if (command === 'snapshot') return normalizeProviderSnapshot(document);
  return import('./agent-workflow.js').then(workflow => workflow[command](document, options));
}
