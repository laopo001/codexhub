# Codex Hub compile-time target for Eclipse Theia

This package is the advanced, compile-time target for teams building a custom
Theia product. Users of the official Theia IDE should install the CodexHub VSIX
with `pnpm run install:theia` instead; they do not need this package.

## Add to a Theia application

Add the package to both the browser and Electron application packages that
compose your Theia product:

```json
{
  "dependencies": {
    "@dadigua/codexhub-theia": "^0.4.16"
  }
}
```

Rebuild the Theia application after installing it. Theia extensions are loaded
at build time; this package is not a VSIX and is not installed through Open VSX.

Use `pnpm run package:theia` to produce the package under `dist-theia/`, add it
to the custom product's application dependencies, and rebuild that product.

The target adds a **Codex Hub** view to the left area. Each Theia frontend
connection starts an embedded Codex Hub server on a random loopback port and
uses the current workspace roots as a fixed project catalog.

## Native notifications

The Electron target creates notifications in the Electron main process. A
notification click restores and focuses the source `BrowserWindow`, activates
the Codex Hub view, and opens the notification's `threadId`.

Browser-only Theia applications fall back to the Web Notifications API and
cannot guarantee operating-system window activation.

Optional data root:

```bash
export CODEX_HUB_THEIA_DATA_DIR="$HOME/.config/codexhub/theia"
```

The default uses the same directory and creates a stable subdirectory per
workspace set.
