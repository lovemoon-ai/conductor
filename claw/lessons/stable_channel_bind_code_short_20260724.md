# Channel bind codes could be shorter than six characters

## Symptom

`issueBindCode()` occasionally returned a code shorter than the six characters
promised by the API and UI. The web test suite reproduced this with the
four-character code `IAAD`.

## Root cause

The generator encoded random bytes with Base64URL, removed `-` and `_`, and
then sliced the remainder to six characters. When the encoded value contained
more than two of those removed characters, fewer than six characters remained.

## Fix

Generate each of the six characters independently with `crypto.randomInt()`
from the explicit `A-Z0-9` alphabet. The regression test injects a deterministic
random index and verifies both the exact six-character result and six random
draws.

## Prevention

Do not create fixed-width tokens by filtering a variable-width representation.
Choose every output character from its final alphabet, and make randomness
deterministic in tests so edge cases cannot depend on chance.
