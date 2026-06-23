# Contributing

Thanks for improving Across Autopilot. Keep changes aligned with the product
boundary: Autopilot owns LoopSpec supervision, trigger queues, Tool Packs,
candidate policy, evidence, telemetry, and promotion readiness. Hosts own UI,
credentials, plugin management, and release approval.

## Development

```bash
npm install
npm run check
```

There are currently no runtime npm dependencies. New dependencies should be
small, necessary, and compatible with local-first open-source distribution.

## Pull Request Checklist

- Keep stable source A read-only during autonomous self-iteration tests.
- Keep candidate writes under bounded B/C workspaces.
- Do not commit runtime data from `~/.across`, candidate workspaces, source
  mirrors, logs, app bundles, API keys, model credentials, signing files, or
  private local paths.
- Add or update tests for LoopSpec contracts, adapter behavior, evidence,
  trigger handling, and promotion policy when those areas change.
- Update `README.md` and `AUTOPILOT_RFC.md` when public behavior or product
  boundaries change.

## Release Notes

Public releases should summarize new Loop Engineering capabilities, compatible
Across component versions, validation evidence, and any remaining human
approval boundaries.
