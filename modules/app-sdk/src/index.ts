/**
 * @conductor/app-sdk root entry.
 *
 * This entry is environment-agnostic: it re-exports pure types plus a few
 * runtime constants. Safe to import from Node, browsers, Edge runtimes, and
 * React Server Components.
 *
 * Use the subpath entries for runtime code:
 *   - `@love-moon/app-sdk/server` — Node SDK for talking to Conductor.
 *   - `@love-moon/app-sdk/react`  — React chat widget.
 */
export * from './types/index.js';

export const SDK_VERSION = '0.1.0';
export const SDK_NAME = '@love-moon/app-sdk';

/**
 * User-Agent fragment the SDK sets on every outbound HTTP request.
 * Format: `conductor-app-sdk/<version>`.
 */
export const SDK_USER_AGENT = `conductor-app-sdk/${SDK_VERSION}`;
