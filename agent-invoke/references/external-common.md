# External execution safety

Use an external client only after the caller has selected it and supplied a
canonical workspace, immutable model/effort/permission settings, and a private
regular prompt file. The launcher runs in that exact workspace and supplies
the prompt only on stdin; never interpolate prompt content into argv.

The first identity is provisional. A failed dependency, authentication, quota,
permission, child-identity, or authoritative-start check is a refusal: do not
fall back to another client or mode. Keep the active turn and unsealed record
for inspection; do not make it resumable. Captures and setting manifests are
private, per-operation files. Resume requires the sealed exact session and an
identical settings manifest.

Do not report completion from a client exit alone. Completion is controlled by
the monitor after transcript evidence, and only it may clear the matching turn.
