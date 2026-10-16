# kubuno-storage

The storage abstraction shared by the Kubuno core and its modules: one async trait
for reading and writing blobs, a local filesystem backend, and the path and naming
conventions that keep users' files laid out the same way everywhere.

```toml
kubuno-storage = { git = "https://github.com/kubuno/core", tag = "storage-v0.1.1", package = "kubuno-storage" }
```

---

## API

### The backend

```rust
let storage: Arc<dyn StorageBackend> = kubuno_storage::from_config(&settings.storage).await?;

storage.put("owner/files/report.pdf", bytes).await?;
let stream = storage.get_range("owner/files/video.mp4", 0, 1_048_575).await?;
```

`from_config` is called once at startup, by the core and by each module, and
returns the backend named by the configuration. `StorageBackend` is an
`async_trait` covering:

| Group | Methods |
|---|---|
| Read / write | `put`, `put_stream` (with an optional size hint), `get`, `get_stream`, `get_range` |
| Inspect | `exists`, `size`, `list` (→ `StorageObject { path, size, content_type }`) |
| Organise | `copy`, `mv`, `delete`, `create_dir`, `mv_dir`, `delete_dir` |
| Multipart upload | `init_multipart`, `put_part`, `complete_multipart`, `abort_multipart` (→ `MultipartPart { part_number, etag }`) |
| Links | `presign_get` |

Streams are `ByteStream` - a boxed, `Send` stream of `StorageResult<Bytes>`.
Errors are `StorageError`: `NotFound`, `InvalidPath`, `Io`, `S3`,
`MultipartNotFound`, `Internal`.

### Configuration

`StorageConfig` deserialises from the host's configuration file:

| Field | Meaning |
|---|---|
| `backend` | `"local"` or `"s3"` |
| `local_path` | storage root (default `./data/files`) |
| `temp_path` | temporary area (default `./data/tmp`) |
| `s3_bucket`, `s3_region`, `s3_endpoint`, `s3_access_key`, `s3_secret_key` | reserved for the S3 backend |

### Paths and names

`path` holds the on-disk layout, relative to the storage root, so the physical tree
mirrors the virtual one:

| Function | Layout |
|---|---|
| `user_file_path(owner, folder, name)` | `{owner}/files{folder}/{name}` |
| `user_folder_dir(owner, folder)` | `{owner}/files{folder}` |
| `user_version_path(owner, file, n, name)` | `{owner}/versions/{file}/{n}/{name}` |
| `user_thumbnail_path(owner, file)` | `{owner}/thumbnails/{file}.jpg` |
| `upload_temp_dir_v2(session)` / `chunk_path_v2(session, i)` | `.uploads/{session}/{i:08}.part` |

`naming` resolves collisions the way a file manager does: `unique_file_name`
turns `report.pdf` into `report (2).pdf`, `unique_dir_name` turns `Documents` into
`Documents (2)`, and `strip_ext` drops an extension.

## Backends

- **Local filesystem** (`LocalStorage`) - the backend in use. Every path is
  resolved against the storage root and normalised; anything that would land
  outside it (`../`) is refused with `InvalidPath`. `presign_get` returns the
  path itself, since a local file needs no signed URL.
- **S3-compatible** - declared in the configuration and in the `s3` feature, but
  **not implemented yet**: every call returns an error.

## Features

| Feature | Default | Effect |
|---|---|---|
| `local` | yes | declared for the local backend |
| `s3` | no | declared for the future S3 backend |

Neither feature gates code at present; both backends are always compiled.

## Who uses it

The core, and the modules that store user content: app, assistant, books, chat,
code, contacts, drive, flow, forms, keestore, maps, media, notes, office,
paintsharp, photos and tasks.

## Tests

```bash
cargo test -p kubuno-storage
```

They cover the naming rules, the path layout and the local backend, path traversal
included.

## License

[AGPL-3.0-or-later](../../LICENSE) © Kubuno contributors.
