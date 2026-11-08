# Uncertain chat errors need actionable recovery instructions

## Symptom

An early stop, timeout or interrupted stream marks a conversation for review.
Later sends fail with REVIEW_REQUIRED, but Conductor offered no inspection or
acknowledgement instructions except on login-related failures.

## Root cause

The AI SDK appended the acknowledgement command only inside its authentication
error branch. The runtime correctly preserved uncertainty and rejected unsafe
subsequent sends, leaving the user without an actionable recovery path.

## Fix

Include commands to open the same conversation and explicitly acknowledge its
outcome on the first uncertain error and on REVIEW_REQUIRED. Quote socket paths
for the shell, preserve typed errors and send the instructions through both
terminal status and the normal Conductor error message. Acknowledgement remains
a daemon-host CLI action and never automatically replays the previous prompt.

## Validation and prevention

For both provider types, simulate uncertain interruption, timeout and an
authentication failure after submission. The next send reports the recovery
commands without reaching the provider; explicit acknowledgement permits a new
send. Check paths with spaces and apostrophes, and verify Conductor bridge error
messages contain the instructions. These tests use fake workers, not live accounts.
