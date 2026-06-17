# Design: Local Static Artifact Deployment

## Flow

```text
web_app artifact
  -> deploy_artifact
  -> .agent-conference-data/deployments/dep_xxx/
       index.html
       original source files
       .agent-conference/manifest.json
  -> /deployments/dep_xxx
  -> source ZIP
  -> container ZIP
  -> deploy_status message part
```

## Deployment Record

`DeployStatusRecord.previewPath` remains required for backwards compatibility. New records use the stable deployment URL path instead of the live artifact preview route.

Optional fields:

- `deploymentType: 'local_static'`
- `deploymentPath`
- `sourceDownloadPath`
- `containerDownloadPath`
- `summaryInstruction`

`summaryInstruction` exists only to guide Agent text summaries. Agents must not turn `previewPath` into a guessed public URL; user-visible access should rely on the deployment card controls or quote `previewPath` exactly.

## File Safety

Artifact file names are untrusted because they come from LLM/tool output. Deployment materialization rejects absolute paths, parent traversal, empty paths, and NUL bytes before writing files. Static serving also resolves requested paths under the deployment directory and rejects traversal/prefix traps.

## Serving And Downloads

The deployment route serves files from the materialized directory. HTML responses keep CSP sandboxing and `nosniff`, matching the existing artifact preview safety model.

The source ZIP contains the artifact source files and a README. The container ZIP contains the static files plus `Dockerfile`, `nginx.conf`, and README so users can run the preview outside Agent-Conference.
