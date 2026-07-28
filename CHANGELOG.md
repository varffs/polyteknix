# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-07-28

### Added

- Button LED now signals an unacknowledged fault instead of being permanently on. It pulses (750 ms on / 2250 ms off) when the external probe, the internal AHT20, the iotplotter push or the boot clock is faulty, and goes dark once the fault has been seen on the DIAG screen.
- Night suppression: the LED is silent between sunset + 30 min and sunrise − 30 min, computed locally from the site coordinates via `suncalc`. No network call.
- The DIAG screen line 0 continues showing the external sensor status; line 1 now displays non-external fault flags (`int` / `psh` / `clk`) when any are live, displacing the diagnostic text.
- `LED_IGNORE_QUIET=true` bypasses night suppression for development.

### Changed

- The LED is no longer switched on at boot.

## [2.0.0] - 2026-07-27

First tagged release. The device has been running unattended on the polytunnel Pi
since the redux/`piteknix` rebuild; this stamps that state and the history feature
on top of it.

### Added

- LCD backlight sleeps after 30 s; button press wakes it, presses while lit cycle display modes and reset the timeout
- Two history display modes: 24 h min/max and today-vs-yesterday, from an in-memory ring of readings (not persisted — resets on restart)

### Fixed

- Failed internal sensor reads no longer leave the previous reading showing as if current
