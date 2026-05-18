// jsdom doesn't ship a TextEncoder polyfill in some configurations; React 19
// expects it for streaming server renderer. Cheap to seed unconditionally.
import { TextEncoder, TextDecoder } from 'node:util';

if (typeof globalThis.TextEncoder === 'undefined') {
  // @ts-expect-error — assigning into globalThis from Node util types.
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  // @ts-expect-error — same.
  globalThis.TextDecoder = TextDecoder;
}

// React 19's `act` requires this flag to be set in the test environment.
// Without it, every render emits "current testing environment is not
// configured to support act(...)" warnings.
// @ts-expect-error — React-internal global.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
