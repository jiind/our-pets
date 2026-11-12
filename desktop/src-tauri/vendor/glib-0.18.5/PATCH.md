# GLib iterator security backport

This directory contains the complete crates.io `glib 0.18.5` source (MIT). The upstream `LICENSE`, `COPYRIGHT`, metadata and tests are retained. `UPSTREAM-SHA256.json` records every original file and the authenticated crate archive checksum from Cargo.lock.

The only upstream source modification is the two-line fix from [gtk-rs-core PR #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), merged as [05dff0ee696f9bcd8617cd48c4b812d046d440cb](https://github.com/gtk-rs/gtk-rs-core/commit/05dff0ee696f9bcd8617cd48c4b812d046d440cb): declare the output pointer mutable and pass `&mut p` to `g_variant_get_child`. This corrects [RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) while preserving the GTK 3 dependency's 0.18 API and ABI.

Cargo's root `[patch.crates-io]` selects this source for the entire desktop graph. The package retains its genuine upstream version. Do not edit Cargo's external cache or substitute an unrelated version to satisfy a scanner.

`python3 scripts/check_glib_patch.py` verifies provenance hashes, the exact backport, the Cargo override and the lockfile origin. Linux CI also executes `cargo test --locked --release --manifest-path desktop/src-tauri/Cargo.toml --test glib_variant_iter`, exercising all affected iterator methods through actual GLib FFI with optimizations. Both checks must pass before replacing this source.

Remove the override and vendored directory once the complete desktop dependency graph supports an upstream patched release. Keep equivalent optimized iterator coverage. When updating this snapshot, verify the published archive checksum, regenerate the original-file manifest, reapply the reviewed fix if still needed, and retain license notices.
