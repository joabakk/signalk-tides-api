/*
 * BSH (Federal Maritime and Hydrographic Agency, Germany), Water Level Forecast API (no key):
 * https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast  (OGC API Features, ldproxy)
 *
 *   collections/waterlevelforecastdata/items?bbox=...&f=json   stations near the boat
 *   collections/waterlevelforecastdata/items/{id}?f=json      one station:
 *     high_water_low_water  HW/NW events: tidal_prediction_value (astronomical) and, for the next
 *                           few, BSH's official forecast_value
 *     curve                 every 10 min (15 on the Baltic): tidal_prediction, automated_curve_forecast
 *                           and measurement (from the station's PEGELONLINE gauge)
 *     gaugezero_relative_to_nhn, chartdatum_relative_to_gaugezero
 * All levels in cm above the gauge zero; times with their offset ('2026-11-06 16:29:00+01:00').
 * About 136 stations on the North Sea and Baltic coasts; Baltic stations have no tide predictions
 * (hardly any tide), only the forecast and the measurement.
 *
 * Heights above chart datum (LAT on the North Sea, mean water on the Baltic) by default, or NHN.
 * Data: BSH, open data under CC BY 4.0 (a high-value dataset), official forecasts per §1 SeeAufG.
 *
 * Requests: stations within the distance limit when the boat has moved 5 km from the last search,
 * then the nearest station's item at the refresh interval (default 15 min, about 37 kB).
 */

const createProvider = require('../lib/tide-provider')
const { http, buildUrl, noData, quiet, nearest, maxDistance: maxDistanceOption, distance } = createProvider

const DEFAULT_API_URL = 'https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast/collections/waterlevelforecastdata'
const SEARCH_AGAIN = 5000 // m moved since the last station search

const readTime = s => new Date(String(s).trim().replace(' ', 'T'))
const cm = v => v === null || v === undefined || v === '' ? NaN : Number(v)

// One station's item -> series in cm above the gauge zero
function readStation (feature) {
  const p = feature && feature.properties
  if (!p) throw new Error('no station in the answer')
  const series = key => (p.curve || [])
    .map(r => ({ time: readTime(r.timestamp), value: cm(r[key]) }))
    .filter(x => !isNaN(x.time.getTime()) && isFinite(x.value)).sort((a, b) => a.time - b.time)
  const extremes = (p.high_water_low_water || []).map(e => ({
    time: readTime(e.event_timestamp),
    value: cm(e.tidal_prediction_value),
    flag: e.event === 'HW' ? 'high' : e.event === 'NW' ? 'low' : ''
  })).filter(x => x.flag && !isNaN(x.time.getTime()) && isFinite(x.value)).sort((a, b) => a.time - b.time)
  return {
    id: String(feature.id),
    name: String(p.gauge_label || feature.id),
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
    region: p.region || null,
    gaugeZeroNhn: Number(p.gaugezero_relative_to_nhn), // cm
    chartDatum: Number(p.chartdatum_relative_to_gaugezero), // cm above the gauge zero
    extremes,
    predicted: series('tidal_prediction'),
    forecast: series('automated_curve_forecast'),
    observed: series('measurement')
  }
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function apiUrl (ctx) {
    return (ctx.options.bshApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function datum (ctx) {
    return ctx.options.bshDatum === 'NHN' ? 'NHN' : 'CD'
  }

  function fetchStation (ctx, id) {
    const url = `${apiUrl(ctx)}/items/${encodeURIComponent(id)}?f=json`
    ctx.debug(`GET ${url}`)
    return getJson(url).then(readStation, err => {
      if (/HTTP 404/.test(err.message)) throw noData(`BSH station ${id} not found`)
      throw err
    })
  }

  const spec = {
    optionKey: 'bsh',
    title: 'BSH (Germany, North Sea and Baltic)',
    name: 'BSH',
    attribution: 'BSH Water Level Forecast (CC BY 4.0); official forecasts, the BSH accepts no liability',
    refreshKey: 'bshRefreshMinutes',
    defaultRefreshMinutes: 15,
    minRefreshMinutes: 10,
    maxObservationAgeMinutes: 60,
    properties: {
      bshDatum: {
        type: 'string',
        title: 'BSH: reference level (zero) for heights',
        enum: ['CD', 'NHN'],
        enumNames: ['Chart datum (LAT on the North Sea, mean water on the Baltic)', 'NHN (German height datum)'],
        default: 'CD'
      },
      bshRefreshMinutes: {
        type: 'number',
        title: 'BSH: minutes between updates (minimum 10)',
        default: 15
      },
      bshMaxDistanceKm: {
        type: 'number',
        title: 'BSH: use the nearest station within this distance (km)',
        default: 30
      },
      bshApiUrl: {
        type: 'string',
        title: 'BSH: API address (the water level forecast collection)',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const s = ctx.state
      const t = ctx.t
      const pos = ctx.position
      const maxDistance = maxDistanceOption(ctx, 'bshMaxDistanceKm', 30)
      // the stations near the boat, with a box a little larger than the distance limit
      if (!s.search || distance(s.search.at, pos) > SEARCH_AGAIN || s.search.maxDistance !== maxDistance) {
        ctx.job('search', 'stations nearby', () => {
          const dLat = maxDistance / 111320 * 1.1
          const dLon = dLat / Math.max(0.2, Math.cos(pos.latitude * Math.PI / 180))
          const bbox = [pos.longitude - dLon, pos.latitude - dLat, pos.longitude + dLon, pos.latitude + dLat].map(v => v.toFixed(4)).join(',')
          const url = buildUrl(`${apiUrl(ctx)}/items`, { bbox, f: 'json', limit: 50 })
          ctx.debug(`GET ${url}`)
          return getJson(url).then(body => {
            const stations = ((body && body.features) || []).map(readStation)
            s.search = { at: { latitude: pos.latitude, longitude: pos.longitude }, maxDistance, stations }
            // the answer already holds the stations' data
            stations.forEach(st => { s.data = s.data || {}; s.data[st.id] = { station: st, fetchedAt: t } })
          })
        })
      }
      ctx.job('plan', 'station', () => {
        const found = s.search && nearest(s.search.stations, pos)
        if (!found || found.distance > maxDistance) {
          s.station = undefined
          throw quiet(`no BSH station within ${maxDistance / 1000} km`)
        }
        s.station = found.item.id
        const d = s.data && s.data[s.station]
        if (d && t - d.fetchedAt < ctx.refreshMs) return
        ctx.job('station', 'water level forecast', () => fetchStation(ctx, s.station).then(st => {
          s.data[st.id] = { station: st, fetchedAt: t }
        }))
      })
    },
    view (ctx) {
      const d = ctx.state.station && ctx.state.data && ctx.state.data[ctx.state.station]
      if (!d) return null
      const st = d.station
      const nhn = datum(ctx) === 'NHN'
      const shift = nhn ? st.gaugeZeroNhn : -st.chartDatum // cm
      if (!isFinite(shift)) return null
      const m = list => list.map(p => Object.assign({}, p, { value: (p.value + shift) / 100 }))
      return {
        station: { id: st.id, name: st.name, latitude: st.latitude, longitude: st.longitude },
        datum: nhn ? 'NHN' : 'CD',
        extremes: m(st.extremes),
        predicted: m(st.predicted),
        forecast: m(st.forecast),
        observed: m(st.observed)
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.readStation = readStation
