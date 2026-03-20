import createDeepseekProvider from './deepseek.js';

// Generic fallback reuses deepseek heuristics.
export default function createGenericProvider(context) {
  return createDeepseekProvider(context);
}
