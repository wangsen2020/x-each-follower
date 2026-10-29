import {learningStore} from './learning-store.js';
import {resolveWritingContext} from './writing-context.js';

// Compatibility wrapper for existing callers/tests; generation should use writing-context directly.
export async function loadExperienceContext({ownerId, purpose = 'comment', requestId}, deps = {}) {
  return resolveWritingContext({ownerId, purpose, requestId}, {repository: deps.repository || learningStore});
}

export async function finishExperienceUse(id, result, repository = learningStore) {
  try {
    await repository.finishUse(id, {status: result?.ok ? 'generated' : 'failed', result: result?.reply || '', jobId: result?.jobId || null, finishedAt: Date.now()});
  } catch {
    // An audit write failure must not discard already generated content or trigger another AI call.
  }
}
