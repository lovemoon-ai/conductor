// Small helpers for masking handoff-share URLs in logs / error messages /
// task status summaries. Extracted into a dependency-free module so they
// can be unit-tested without loading the rest of the daemon (which would
// otherwise require @love-moon/conductor-sdk and its build artifacts).

// The handoff URL embeds a bearer-style share token in its path. We mask it
// before writing to logs so daemon log files / `ps`-visible output don't leak
// a 24h read-grant for the entire transcript. The full URL still goes into
// the spawned CLI's argv (necessarily — that's how the AI fetches it), but
// the persistent log surface is safe.
//
// The character class `[^/?#\s]+` stops the token at query-string, fragment,
// or whitespace boundaries, so URLs like `.../share/<tok>/plain?x=1` or
// `.../share/<tok>/plain#foo` are still masked instead of leaking verbatim.
// The trailing portion (query/fragment/path tail) is preserved after masking.
export function maskHandoffUrlForLogs(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }
  return value.replace(/\/share\/([^/?#\s]+)/g, (_, token) => {
    const tail = token.length > 4 ? token.slice(-4) : token;
    return `/share/<masked:…${tail}>`;
  });
}

// Scrub any handoff URL embedded in an error message before surfacing it via
// logs or task status summaries. Belt-and-suspenders for the case where an
// internal error stringifies the outbox payload.
//
// Metadata (`name`, `code`, `cause`, any own props the caller attached) is
// preserved on the clone so downstream consumers that switch on those fields
// (retry policies, status mappers) keep working after scrubbing. The
// prototype chain is also preserved so `instanceof` checks survive.
//
// Stack frames in some runtimes embed argument strings in the source
// snippet; the stack is passed through the same masker so a URL that
// happens to appear in a frame cannot leak through the log that prints
// the stack.
export function maskErrorForLogs(error) {
  if (!error) {
    return error;
  }
  const message = typeof error === "string" ? error : error.message;
  if (typeof message !== "string") {
    return error;
  }
  const masked = maskHandoffUrlForLogs(message);
  if (masked === message) {
    return error;
  }
  if (typeof error === "string") {
    return masked;
  }
  const proto = Object.getPrototypeOf(error) || Error.prototype;
  const clone = Object.create(proto);
  Object.assign(clone, error);
  clone.message = masked;
  clone.name = error.name || clone.name || "Error";
  clone.stack =
    typeof error.stack === "string"
      ? maskHandoffUrlForLogs(error.stack)
      : error.stack;
  return clone;
}
