# Changelog

## Unreleased

### Added
- Marine Institute provider (Ireland): high and low waters, the predicted level and the measured level
  at the nearest gauge, above LAT or OD Malin. Free, CC BY 4.0.
- Environment Agency provider (England): measured tide level at the nearest gauge, in mAOD or the
  gauge's local datum. Free, Open Government Licence.
- PEGELONLINE provider (Germany): measured water level at the nearest WSV gauge, above NHN or the gauge
  zero. Free, dl-de/zero-2-0.
- LINZ provider (New Zealand): high and low waters above chart datum at 83 ports, from LINZ's yearly
  tide tables, kept in the data folder (works offline for the year). Free, CC BY 4.0.
- IOC provider (worldwide): raw measured sea level at the nearest IOC gauge, relative to the gauge's own
  zero. A fallback like Open-Meteo.

### Changed
- NOAA: rebuilt on the shared base. Adds the 6-minute prediction and the measured water level from a
  gauge within 5 km (`heightNow`, `heightObserved`, `weatherEffect`); high and low waters as before. The
  station list moves from `noaastations.json` in the config folder to `noaa-stations.json` in the plugin's
  data folder, and NOAA's errors now show in the plugin status.
- Providers ask again for predictions that end too soon at most once an hour.

## 0.7.0

### Added
- Rijkswaterstaat provider (Netherlands): astronomical high and low waters, astronomical tide, measured
  and forecast water level at the nearest Rijkswaterstaat location with tide predictions. Heights above
  NAP. Free, no API key. Data CC0.
- CHS provider (Canada): predicted high and low waters, predicted, measured and forecast water level from
  the IWLS API of Fisheries and Oceans Canada. Heights above chart datum. Free, no API key;
  non-commercial licence.
- SMHI provider (Sweden): measured sea level at the nearest SMHI gauge, in RH2000 or relative to mean
  water level. No predictions. Free, CC BY 4.0.
- FMI provider (Finland): sea level forecast for the boat's position and the measured level at the
  nearest FMI tide gauge, relative to mean water level or N2000. No highs and lows (the Baltic has hardly
  any tide). Free, CC BY 4.0.
- Open-Meteo provider (worldwide): modelled sea level with its air pressure part, for the model grid cell
  at the boat. Not for coastal navigation. Free for non-commercial use, CC BY 4.0.
- Offline provider (worldwide, no internet): astronomical tide computed on the boat with Neaps from
  TICON-4 and NOAA harmonic constants. Neaps (about 57 MB) is an optional peer dependency, not installed
  with the plugin: `npm install neaps` in the server folder.
- A shared base for providers (`lib/tide-provider.js`): request queue, back-off, caching of station
  lists, deltas, status and the `tides` resource, with its own tests.
- `tools/capture-fixtures.mjs` to record real sample responses for the tests; the new providers are
  tested against responses captured on 2026-10-15.

### Changed
- The `tides` resource asks station-based providers before the fallbacks (offline, Open-Meteo).
- Providers with measurements only (SMHI, FMI) don't serve the `tides` resource.
- The fallbacks (offline, Open-Meteo) publish no tide values while a station-based provider does.
- Kartverket, DMI and the new providers share their helpers instead of copying them.

## 0.6.0

### Added
- DMI provider (Denmark, Greenland, Faroe Islands): next high and low tide at the nearest of DMI's
  about 220 prediction stations, the astronomical tide now, the water level measured every 10 minutes
  at the station's tide gauge, and the weather effect (measured minus predicted). Heights relative to
  DVR90 or above the station's lowest astronomical tide. Free, no API key. Also feeds the `tides`
  resource. Data: Danish Meteorological Institute (DMI), CC BY 4.0.
- Tests for the DMI provider (`test/dmi.test.js`) against real DMI responses.

## 0.5.0

Not published to npm; these changes are released in 0.6.0.

### Added
- Tide predictions as the Signal K resource `tides` (`/signalk/v2/api/resources/tides`), in the same
  shape as the signalk-tides plugin: the next 7 days of highs and lows from Kartverket or NOAA. Can be
  turned off in the settings (the server merges the answers when signalk-tides provides it too).
- Tests for the resource and the NOAA forecast (`test/tides-resource.test.js`), run by `npm test`.

### Changed
- Kartverket: the tide table request covers 7 days instead of 30 hours (still one request per tide).

### Removed
- **Breaking:** the NOAA endpoint `/signalk/v1/api/resources/tides/closest`, which the plugin registered
  with a server-wide `app.use` outside the resources API. Use the `tides` resource instead.

### Fixed
- NOAA: the next-tide request started from the wrong time: the hour was formatted as the month
  (`MM:mm`), and in server local time while NOAA was asked for GMT.

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
