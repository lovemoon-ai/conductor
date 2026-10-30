# Share-token authorization bypass through a multipart header

## Symptom

A daemon_share token could PATCH an ordinary guest task with JSON bytes while
claiming Content-Type: multipart/form-data. The request returned 200 and wrote
metadata.globalBackend and launchConfig.remoteWorkspace, minting a remote grant
without a full-token user authorizing that task.

## Root cause

The auth middleware skipped body inspection whenever the caller's header
contained multipart/form-data. The task PATCH route instead reads text and
parses JSON regardless of that header. The two parsers therefore disagreed on
the same bytes, and the shared-credential field restrictions never saw them.

## Fix

Select body handling by normalized route and HTTP method. Task JSON bodies are
inspected on a clone regardless of Content-Type. Only actual attachment POSTs
and raw file-content PUTs skip JSON buffering; those handlers stream files and
take the scoped task or host from the URL.

## Prevention and verification

Authorization and the downstream route must interpret identical request bytes.
Never use a caller-controlled media type to bypass a security-relevant parser.
Keep streaming exemptions specific to the handlers that require them.

Permanent regressions reproduce the attack against both /api/tasks/:id and the
/tasks/:id alias, expecting 401 and no task write. Middleware tests also check
the parsed fields, preservation of the original body for the route, attachment
streaming, and existing raw file uploads. The task PATCH probes returned 200
before this fix and are rejected after it.
