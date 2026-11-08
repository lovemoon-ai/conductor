# Sending a prompt must refresh idle retention activity

## Symptom

A direct runtime client can submit to a workerless conversation that has become idle since startup. Collecting before recording the new activity could remove that same conversation and leave a queued turn without its parent.

## Root cause

The accepted prompt updated lastActivityAt after the idle-retention pass.

## Fix

Record the accepted prompt's activity in the staged state before pruning. A failed transaction still rolls back the activity along with the turn.

## Validation and prevention

Advance the clock by eight days after startup, submit directly without a prior resume, and verify the conversation remains resident and its turn completes.
