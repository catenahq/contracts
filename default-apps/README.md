# default-apps

The wiring of the apps Catena installs by default (Beszel): one file that catena-ce, catena-admin,
catena-templates and ops read, so the stack names, networks, ports, volumes and capabilities agree everywhere.

## Files

| File | What it is |
| --- | --- |
| `wiring.json` | The values. |
| `schema.json` | JSON Schema of `wiring.json`. |

## Shape

Top level:

- `reserved_capabilities`: capability -> `{provider, readers}`. `provider` is the app id that provides it, `readers` the
  app ids that may read it.
- `alert_intake_sources`: intake source -> the app id whose block may read that source's token, the stored secret
  `alert_intake_token_<source>` (`resources` is read by Beszel; the `status` token is core's: catena-admin's uptime check posts with it, and no app
  reads it). The read token is read by no app.
- `apps`: app id -> the entry below.

An app entry:

| Key | Meaning |
| --- | --- |
| `stack` | Swarm stack name, `catena-<id>`. |
| `services` | Service name -> `networks` (network -> aliases), `ports` (`published`, `target`), `host_network`, `docker_socket`. |
| `volumes` | Volume key (as the app's compose names it) -> volume name `<stack>_<key>`. |
| `env_core_writes` | Keys catena-ce writes into the app's `.env` with `setenv`; the app's block never declares them. |
| `env_declared` | Every key the block declares: settings, managed and generated. Core writes none of them. |
| `secrets` | Store secrets the block lists. |
| `provides` | Capability -> the `.env` key names it exposes. |
| `reads` | Capabilities the app reads. |

## Consumers

Each consumer's tests read this file as a sibling checkout:

- catena-templates `tests/test_monitoring_apps.py`
- catena-ce `ansible/tests/unit/test_default_apps.py`
- catena-admin applint reserved capability table
- ops `automation/test_bench` default app checks

## Changing it

`node scripts/validate-json.mjs` checks the shape: every app has `stack` `catena-<id>`, every volume name is
`<stack>_<key>`, every port pair is two integers, and every provider and reader of
a reserved capability is an app of the file and agrees with that app's `provides` and `reads`, and every app named in
`alert_intake_sources` is an app of the file that lists the source's token in its `secrets`.

A change needs every consumer's tests to pass in the same push window: put the change and the consumer changes on
branches of the same name.
