# host-layout

The folders and files a Catena server holds, as more than one repository names them: catena-ce renders and installs
them, catena-admin reads and writes them, catena-templates protects the machine's folders from an app, and ops checks
them on a test server. The paths are written once here, and each repository's tests hold its own copy to this file.

## Files

| File | What it is |
| --- | --- |
| `layout.json` | The values. |
| `schema.json` | JSON Schema of `layout.json`. |

## Shape

| Key | Meaning |
| --- | --- |
| `roots` | `data` (the storage mount), `config` (the rendered configuration) and `state` (the machine state the engines write). |
| `data_folders` | The folders under `roots.data`: `apps`, `compose`, `backup_staging`, `docker`, `volumes` (the Docker named volumes, under `docker`). |
| `files` | Name -> path of each file or folder under `roots.config` or `roots.state` that at least two repositories name. |
| `machine_trees` | The machine's own folders, which an app's folder list may not be at, under or above. |
| `data_trees` | The folders inside a machine tree whose children are data. |
| `backup_set` | The folders the product's backup keeps on every host. |

A path is a literal: no variable moves it here. The overrides a repository allows (a test bench pointing a path at a
scratch folder) stay in that repository.

## Consumers

Each consumer keeps its own constants and holds them to this file in a test that reads it as a sibling checkout; no
consumer reads it at run time, because the admin image and the hosts have no contracts checkout.

- catena-ce `ansible/tests/unit/test_host_layout.py`
- catena-admin `payload/engines/hostlayout`, `payload/engines/systempath` and `payload/engines/applint` tests
- catena-templates `tests/test_quiesce_lint.py`
- ops `automation/test_bench/tests/test_product_constants.py`

## Changing it

`node scripts/validate-json.mjs` checks the shape:

- the top level, `roots` and `data_folders` hold exactly the keys of `schema.json`;
- every path is absolute and clean (no trailing slash, no `.` or `..`, no empty segment);
- no value appears twice among `roots`, `data_folders` and `files`, nor twice within a list;
- every `data_folders` entry is under `roots.data`;
- every `files` entry is under `roots.config` or `roots.state`;
- `roots.data` is in `machine_trees`, and every `data_trees` entry is strictly under a `machine_trees` entry;
- every `backup_set` entry at or under `roots.data` is one of the `data_folders`. Entries outside `roots.data` (the
  host's `/etc`, `/var/lib/dpkg` and the like) are only checked for the first two rules.

Add a path to `files` only when a second repository names it. A change needs every consumer's tests to pass in the same
push window: put the change and the consumer changes on branches of the same name.
