# Selected EmulatorJS Cores

This local EmulatorJS bundle intentionally self-hosts only three platforms for the site emulator project.

## Runtime layout

EmulatorJS expects core files in this flattened layout:

```text
emulator/data/cores/<core>-wasm.data
emulator/data/cores/<core>-legacy-wasm.data
emulator/data/cores/<core>-thread-wasm.data
emulator/data/cores/<core>-thread-legacy-wasm.data
emulator/data/cores/reports/<core>.json
```

The original npm install layout under `node_modules/@emulatorjs/core-*` is not copied into the website bundle.

## Included platforms

| Platform | EJS_core | Runtime core | Purpose |
|---|---|---|---|
| Game Boy Advance | `gba` | `mgba` | GBA games; touch/gamepad layouts are built into EmulatorJS. |
| NES / Famicom | `nes` | `fceumm` | NES/FC games; this is EmulatorJS' first/default NES core. |
| Mega Drive / Genesis | `segaMD` | `genesis_plus_gx` | Sega MD/Genesis games; this is EmulatorJS' first/default MD core. |

## Included files

- `mgba-*.data` and `reports/mgba.json`
- `fceumm-*.data` and `reports/fceumm.json`
- `genesis_plus_gx-*.data` and `reports/genesis_plus_gx.json`

Approximate selected `.data` payload size: 13 MB.

## Notes

- Use `window.EJS_pathtodata = './data/';` from `emulator/index.html`.
- This local bundle currently uses non-minified EmulatorJS runtime files, so a test page should set `window.EJS_DEBUG_XX = true` unless/minified files are added later.
- Do not add commercial ROMs to the public repository unless you have distribution rights.
