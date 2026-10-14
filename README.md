# signalk-tides-API

This is a copy of sbender9's derived-data.

Currently serving worldtide.info API, NOAA free data and Kartverket (Norway) free data, it can potentially serve other APIs and web sources for tidal data. Please feel free to contribute

> **Coming back from signalk-tides?** In 2025 this plugin stopped producing data on newer servers
> (#67), and [signalk-tides](https://www.npmjs.com/package/signalk-tides) by @bkeepers was published
> as a rewrite. Version 0.4.0 of this plugin fixes that: providers now update on an interval (#73),
> it starts without a GPS fix, and it adds a free Kartverket provider for Norway with forecast and
> observed water levels. Both plugins are maintained; pick the one whose providers suit your area.
> See the [changelog](CHANGELOG.md).

## Providers

Enable one provider under *Tides* in the plugin configuration.

| Provider | Area | Key needed |
|---|---|---|
| NOAA | US only | no |
| worldtides.info | worldwide | yes, paid |
| Kartverket | Norway | no |

### Kartverket (Norway)

Uses the free water level API of Kartverket, the Norwegian Mapping Authority
(https://vannstand.kartverket.no/tideapi_en.html), queried for the boat's position
(`tide_request=locationdata`).

![Kartverket tide data for Fredrikstad in the Signal K Data Browser](docs/screenshot-data-browser.png)

Published paths (heights in metres above the chosen reference level, times in UTC ISO 8601):

| Path | Contents |
|---|---|
| `environment.tide.heightHigh`, `environment.tide.timeHigh` | next high tide |
| `environment.tide.heightLow`, `environment.tide.timeLow` | next low tide |
| `environment.tide.heightNow` | water level now: observed if Kartverket has an observation at the boat's position, otherwise Kartverket's forecast (astronomical tide plus weather effect), otherwise the astronomical prediction |
| `environment.tide.heightPredicted` | astronomical tide now (not in the Signal K specification) |
| `environment.tide.heightForecast` | forecast water level now, including wind and air pressure (not in the specification) |
| `environment.tide.weatherEffect` | forecast minus prediction, i.e. the effect of wind and pressure (not in the specification) |
| `environment.tide.heightObserved` | latest observed water level, not older than 3 hours (not in the specification) |

In the Oslofjord and Skagerrak the astronomical tide is small (about 30 cm range at Fredrikstad),
so wind and air pressure often matter more. Compare `heightForecast` or `heightObserved` with `heightPredicted`.

Options:

| Option | Default | |
|---|---|---|
| Reference level | Chart datum (CD) | `CD` chart datum (sjøkartnull), `MSL` mean sea level, `NN2000` Norwegian height datum |
| Minutes between water level updates | 30 | minimum 10 |
| Station latitude / longitude | empty | position of a Kartverket tide gauge (find it on https://kartverket.no/en/at-sea/se-havniva). Usually not needed: where Kartverket derives a position's tide from a nearby gauge, it also returns that gauge's observations (Fredrikstad gets Viker's, shifted 5 minutes and scaled by 1.03). Set this only if `heightObserved` stays empty for your area. Costs one extra request per update. |
| API address | `https://vannstand.kartverket.no/tideapi.php` | change only if Kartverket moves the service (it used to be `api.sehavniva.no`) |

Requests and caching: the high/low table is requested again only after the next high or low tide has
passed (or when the boat has moved more than 5 km); the hourly water levels are requested at the update
interval. Between requests the cached values are re-published every minute, so `heightNow` keeps changing
without extra load on the service. After a failed request the provider waits 5 minutes, then 10, 20 and so on,
up to the update interval (at least 30 minutes); a position Kartverket has no data for is asked again only once per interval.
Every request carries a `signalk-tides-api/<version>` User-Agent, as Kartverket asks API users to keep
requests to a minimum.

Attribution: water level data from Kartverket, Norwegian Mapping Authority, Hydrographic Service,
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit Kartverket when you show
or share the data.

## Tides resource

The plugin provides the coming high and low tides as the Signal K resource `tides`, in the same shape as
the [signalk-tides](https://www.npmjs.com/package/signalk-tides) plugin, so apps reading one work with the other:

```
$ curl http://localhost:3000/signalk/v2/api/resources/tides
```

```json
{
  "datum": "CD",
  "units": "meters",
  "station": { "id": "kartverket/VIK", "name": "Viker", "latitude": 59.21, "longitude": 10.95 },
  "extremes": [
    { "time": "2026-10-12T16:45:00.000Z", "level": 0.771, "high": true, "low": false, "label": "High" },
    { "time": "2026-10-12T22:21:00.000Z", "level": 0.568, "high": false, "low": true, "label": "Low" }
  ]
}
```

The data comes from the first enabled provider that can forecast: Kartverket (the next 7 days, `datum` is the
chosen reference level) or NOAA (the next 7 days at the closest NOAA station, `datum` MLLW, cached for an
hour). worldtides.info does not provide it. The answer uses the data the providers already fetch, so it adds
no requests to Kartverket.

The Signal K server merges the answers of all plugins that provide the same resource type. If
signalk-tides is installed too, turn off *Provide tide predictions as the resource* in this plugin's
settings, so that the two answers are not mixed.

Until version 0.4.1 the NOAA provider served `/signalk/v1/api/resources/tides/closest` (NOAA only, outside
the resources API). That address is gone; use the resource above.

## Tests

```
npm test
```

Runs the tests offline. The Kartverket provider is tested against XML fixtures in `test/fixtures`:
`kartverket-live-*.xml` are real responses for Fredrikstad (data: Kartverket, CC BY 4.0); the others are
synthetic, in the same format. The tides resource and the NOAA forecast are tested with simulated NOAA
responses.
