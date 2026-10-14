# Changelog

## Unreleased

### Changed
- **The NOAA closest-station endpoint moved** from `/signalk/v1/api/resources/tides/closest` to
  `/plugins/tides-api/closest`. It is now registered through the plugin router (`registerWithRouter`)
  with read-only access instead of a server-wide `app.use`. Anything calling the old address needs
  updating.

### Added
- Tests for the NOAA endpoint (`test/noaa-endpoint.test.js`), run by `npm test`.

## 0.4.1

### Changed
- README: note for users who moved to signalk-tides when this plugin stopped producing data
  (#67), pointing to the 0.4.0 fixes. Removed the dead Travis CI badge.

## 0.4.0

### Added
- Kartverket (Norway) tide provider: next high and low tide, water level now (observed where
  Kartverket has observations, otherwise forecast or astronomical prediction), and the predicted,
  forecast and observed levels and the weather effect (wind and air pressure). Free, no API key.
  Data: Kartverket, Norwegian Mapping Authority, Hydrographic Service, CC BY 4.0.
- Tests (`npm test`), run offline against real and synthetic Kartverket responses.

### Fixed
- The plugin failed to start when no position was available yet ("Cannot read properties of
  undefined (reading 'value')"), e.g. when Signal K starts before the GPS has a fix.
- Stopping the plugin (also when saving its settings) left the hourly update loop running.
- worldtides.info: a failed request is now reported instead of being left unhandled.
- Uses `setPluginStatus`/`setPluginError` on servers that have them (no deprecation warning).

### Changed
- Providers update on an interval (#73).
- Dependencies: removed unused `baconjs`, `cubic-spline`, `lethexa-motionpredict`, `suncalc` and
  `snyk`; replaced the deprecated `request`, `superagent-promise` and `promise` with current
  `superagent`; updated `lodash` and `moment`. `npm audit` reports no vulnerabilities.

## 0.3.0
- More NOAA debugging (#37).

## 0.2.0
- NOAA tides fixed (#34).
- Dependency updates.

## Earlier versions
- worldtides.info and NOAA (US only) providers. See the git history.
