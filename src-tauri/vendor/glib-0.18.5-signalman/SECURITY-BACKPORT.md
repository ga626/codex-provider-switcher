# Signalman glib security backport

This vendored copy is `glib` 0.18.5 with the upstream fix from
`gtk-rs/gtk-rs-core` pull request 1343 (`b5a4071e439bef2b5eea76c3aa25e5ae84839e34`).

The fix changes `VariantStrIter::impl_get` to pass the C out-parameter as
`&mut p`, matching the function's write semantics and removing the undefined
behavior described by GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429.

The application currently ships Windows x64. `glib` is only resolved through
Tauri's non-Windows GTK dependency branch; this backport keeps that branch safe
without pretending that the incompatible `glib` 0.20 migration is complete.
When the Tauri/Wry GTK graph supports `glib` 0.20, remove this directory and
the `[patch.crates-io]` entry and upgrade the normal registry dependencies.
