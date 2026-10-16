# kubuno-seccomp

A one-call kernel sandbox that forbids a Kubuno process from ever starting another
program.

```toml
kubuno-seccomp = { git = "https://github.com/kubuno/core", tag = "seccomp-v0.1.1", package = "kubuno-seccomp" }
```

---

## Why it exists

Kubuno's security objective here is simple: **no user of the application must be
able to run a command on the machine that hosts it**. Most modules never need to
start an external binary in normal operation - the database is reached over the
network, inter-module calls are HTTP, Git goes through an in-process library, and
cryptography, images and scripting all run in-process. For those modules the
property can be made *unbreakable at the kernel level*: after the filter is
installed, not even a future regression, a compromised dependency or a crafted
input can call `execve`.

## Usage

Call it once, early in `main`, before serving requests:

```rust
kubuno_seccomp::lock_down_process_execution("calendar");
```

The argument is only used in the log line. The call never fails from the caller's
point of view:

- on success it logs that process execution is now forbidden;
- if the kernel refuses the filter it logs an error and the module carries on
  without the protection (a safe degradation, not a crash);
- on a platform other than Linux x86-64 it logs a warning and does nothing.

## What the filter does

A classic BPF program is installed with `seccomp(2)` in filter mode, preceded by
`PR_SET_NO_NEW_PRIVS` (required to install a filter without root, and a guarantee
that no exec could regain privileges). It is synchronised on **every thread** of
the process (`SECCOMP_FILTER_FLAG_TSYNC`).

| System call | Outcome |
|---|---|
| `execve` | fails with `EPERM` |
| `execveat` | fails with `EPERM` |
| anything else | allowed |

The calls fail with `EPERM` rather than killing the process, so an attempt fails
cleanly inside the module instead of bringing it down.

## Who uses it

The filter is installed by the modules that never need to spawn a process: app,
assistant, books, calendar, chat, code, contacts, flow, forms, forum, keestore,
mail, maps, notes, office, paintsharp, photos, tasks and wiki.

It must **not** be installed in a process that legitimately runs programs:

- **drive** - remote mounts rely on external clients;
- **media** - transcoding and probing run `ffmpeg` / `ffprobe`;
- **the core** itself.

## Limits

- Linux on x86-64 only; the architecture check in the filter lets other ABIs
  through untouched, and other operating systems get no filter at all.
- It restricts program execution, nothing else: file access, network access and
  every other system call are unaffected.

## License

[AGPL-3.0-or-later](../../LICENSE) © Kubuno contributors.
