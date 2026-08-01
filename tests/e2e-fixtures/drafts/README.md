# Terminal-Bench 2 Derived Fixture Drafts

This directory contains test-only design contracts for ten AgentMeld benchmark cases derived from Terminal-Bench 2 tasks.

These files remain as design records outside the top level of `tests/e2e-fixtures`. The benchmark loader is non-recursive, so only cases converted into production fixtures are included in normal `agent:bench` runs.

Current promotion status:

- `tb2d-cancel-async-tasks`: promoted to a production fixture;
- `tb2d-regex-log`: promoted to a production fixture;
- the remaining eight cases are still planning drafts.

Each draft:

- uses `draftSchemaVersion: 1`, not the production benchmark schema;
- references an asset manifest under `tests/e2e-assets/<case-id>/manifest.json`;
- separates public workspace assets from hidden verifier assets;
- declares runtime and assertion requirements, with `status` set to `promoted` only after a production fixture exists;
- contains no official Terminal-Bench solution or hidden official answer.

Promotion to a production fixture requires:

1. Implementing the required runtime/assertion capabilities.
2. Materializing and hashing generated binary assets.
3. Running the hidden verifier independently.
4. Converting the draft to the production schema and moving it to `tests/e2e-fixtures`.
5. Completing one smoke run and three stable model-backed trials.
