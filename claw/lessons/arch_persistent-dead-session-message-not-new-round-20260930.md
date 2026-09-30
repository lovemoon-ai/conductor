# Persistent task: a CLI message after the session died did not start a new round

## Symptom
A persistent task whose session ended without "End round" (status completed,
killed or unknown) started a new round when you sent from the web. A CLI/SDK
message to it went to the dead session and was never answered.

## Root cause
The server only treated `roundEndedAt` as "round idle". The web's `isRoundIdle`
also counts a gone session.

## Fix
`startRoundIfPersistentIdle` (`web/src/lib/tasks/deliver-user-message.ts`)
treats `roundEndedAt` or status completed/killed/unknown as idle and calls
`startPersistentRound`.

## How to avoid next time
Copy the whole predicate from the client, and test each branch of it on the route.
