# Nightly offline tiles (macOS launchd)

This runs the offline tile builder each night and appends logs under `project/debug_output/`.

## Install

Note: The provided plist contains an absolute path to this repo. If you move the repo, update the `ProgramArguments` path accordingly.

1) Copy the plist to your LaunchAgents folder:

- `mkdir -p ~/Library/LaunchAgents`
- `cp tools/macos/com.weathermap.offline-tiles.plist ~/Library/LaunchAgents/`

2) Load it:

- `launchctl load -w ~/Library/LaunchAgents/com.weathermap.offline-tiles.plist`

## Verify

- List jobs: `launchctl list | grep weathermap`
- Inspect logs (builder output): `ls -lt project/debug_output/offline_build_nightly_*.log | head`

## Run once (manual)

- `tools/macos/run_offline_tiles_nightly.sh`

## Stop / uninstall

- `launchctl unload -w ~/Library/LaunchAgents/com.weathermap.offline-tiles.plist`
- `rm ~/Library/LaunchAgents/com.weathermap.offline-tiles.plist`

## Notes

- The job prefers an *incomplete* DB in `project/cache/` (e.g. `offline_weather_2022.sqlite`, `offline_weather_2023.sqlite`) based on `build_state`.
- If no incomplete DB is found, it falls back to `project/cache/offline_weather_<endYear>.sqlite` with `endYear = currentYear - 1`.
- The runner uses the selected DB's stored year range from `meta.years` when present.
- It will not start if a `build_offline_tiles_openmeteo.py` process is already running.
- The builder is restart-safe and will skip tiles already marked as `done`.
- Chunk rotation uses day-of-year modulo 10.

Optional override:
- Run a specific DB: `OFFLINE_TILES_DB=project/cache/offline_weather_2023.sqlite tools/macos/run_offline_tiles_nightly.sh`
