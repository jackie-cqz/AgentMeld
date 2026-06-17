# Design

## Deployment Target

The first real publishing target is `static_directory`.

```txt
deployment_publish_enabled = true
deployment_publish_dir = C:\sites\agent-conference
deployment_public_base_url = https://agent-conference.example.com/apps
```

For deployment `dep_abc`, Agent-Conference writes public files to:

```txt
C:\sites\agent-conference\dep_abc\
```

and returns:

```txt
https://agent-conference.example.com/apps/dep_abc/
```

## Safety

- Agent-Conference writes only into a deployment-id subdirectory.
- If that subdirectory already exists, Agent-Conference removes that subdirectory only after verifying it is inside the configured publish root.
- Private `.agent-conference` deployment metadata is never copied to the publish target.
- The publish root must be absolute and must not be the filesystem root.

## Runtime Record

`DeployStatusRecord` keeps the local deployment metadata and adds external publish metadata:

- `deploymentType: 'local_static' | 'external_static'`
- `localPreviewPath`
- `publicUrl`
- `publishPath`
- `publishTargetType: 'static_directory'`

When external publish succeeds, `previewPath` becomes `publicUrl`. When it fails, the deployment record is failed and includes the local preview path for recovery.
