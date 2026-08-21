# Image upload limit mismatch

## Symptom

The browser allowed a 20–100 MB image to upload fully, after which message binding always failed.

## Root cause

The composer applied the general 100 MB file limit to images while ingress and AI SDK enforce a 20 MB per-image limit.

## Fix

The composer now rejects native raster images above 20 MB before upload.

## Prevention

Expose shared attachment limits or contract tests so frontend, ingress, materializer, and AI SDK cannot drift.
