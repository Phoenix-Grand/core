# Kubuno Desktop - macOS

What macOS does differently from the portable app of [`../common`](../common), and nothing else
(desktop/README.md, "Platform extension points"). Today macOS overrides nothing:
`kubuno-desktop-shell-macos` is the entry point (`kubuno-desktop`), a few lines that run
`kubuno_desktop_shell_common::app::run` with the portable platform and the text interface (the sync folders
and their accounts). A native window and the macOS services (folders, start at logon, notifications) will join
here as implementations of the extension points of `kubuno_desktop_shell_common::platform`.

```bash
cd desktop && cargo run -p kubuno-desktop-shell-macos -- --sample
```
