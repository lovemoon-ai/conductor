/**
 * RFC 0032 catchphrase limits — shared by client UI and server library.
 *
 * Kept in a dependency-free module (no Prisma, no Next server APIs) so it
 * can be imported from both 'use client' components and server-side route
 * handlers / business logic without dragging server-only modules into the
 * client bundle.
 */
export const MAX_CATCHPHRASES_PER_USER = 100;
export const MAX_CATCHPHRASE_TEXT_LENGTH = 500;
