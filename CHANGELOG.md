# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- LCD backlight sleeps after 30 s; button press wakes it, presses while lit cycle display modes and reset the timeout
- Two history display modes: 24 h min/max and today-vs-yesterday, from an in-memory ring of readings (not persisted — resets on restart)

### Fixed

- Failed internal sensor reads no longer leave the previous reading showing as if current
