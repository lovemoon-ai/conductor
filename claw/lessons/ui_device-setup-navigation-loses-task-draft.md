# Device setup navigation lost task instructions

## Symptom

Following Manage devices from a new-task form could discard the instructions and advanced execution options.

## Root cause

The form state lived only in the component being unmounted during navigation.

## Fix

Save a validated, user-scoped session draft specifically before the device-setup detour and restore it when returning. Clear it on cancellation or successful creation; if saving fails, stay in the form with an explanation.

## Prevention and verification

Cover advanced options, offline registry failures, malformed storage, user isolation, successful submission, explicit cancellation, and storage write errors. CreateTaskDialog regression tests exercise these cases.
