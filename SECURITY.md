# Security Policy

Across Autopilot is a local-first autonomous iteration controller. It must not
store provider API keys, raw model credentials, signing identities, notarization
secrets, or private source archives in the repository.

## Supported Versions

Security fixes are applied to the latest released tag. The current supported
release line is `v0.2.x`.

## Reporting

Please report security issues privately to the repository maintainer before
opening a public issue. Include the affected version, reproduction steps, and
whether the issue can mutate stable source, leak credentials, bypass candidate
workspace policy, or incorrectly mark promotion evidence as ready.

## Local Data

Runtime state belongs under `~/.across/data/across-autopilot`. Candidate
workspaces, source mirrors, run evidence, and telemetry are local operator data
and must not be committed to the public repository.

## Boundary Rules

- Hosts own model credentials and user permissions.
- Autopilot receives model access only through host model-command boundaries or
  non-secret Candidate Model Capability Leases.
- Autopilot may create B/C candidate workspaces and evidence, but it must not
  merge, tag, sign, publish, or release without explicit human approval.
