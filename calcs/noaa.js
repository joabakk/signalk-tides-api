/*
 * NOAA CO-OPS (US), Tides & Currents APIs (no key): https://api.tidesandcurrents.noaa.gov
 *
 *   mdapi .../stations.json?type=tidepredictions   prediction stations: reference (type R) and
 *                                                  subordinate (S, highs and lows only)
 *   mdapi .../stations.json?type=waterlevels       stations with a water level gauge
 *   datagetter product=predictions interval=hilo   high and low waters
 *   datagetter product=predictions interval=6      predicted level every 6 minutes (type R)
 *   datagetter product=water_level                 measured level every 6 minutes (preliminary)
 * Heights in m above MLLW (the US chart datum), times in GMT. Public domain.
 *
 * Requests: the station lists monthly (kept in files), highs and lows for 7 days and the predicted
 * level for 2 days only when they run out, and the gauge's last 2 hours at the refresh interval
 * (default 6 min, the gauges' interval) when a gauge is within 5 km of the prediction station.
 */

const createProvider = require('../lib/tide-provider')
const {
  http, buildUrl, noData, quiet, nearest, stationList, maxDistance: maxDistanceOption, stationData, runningOut,
  HOUR, DAY
} = createProvider

const META_URL = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi'
const DATA_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
const DATUM = 'MLLW'
const GAUGE_MATCH = 5000 // m between a prediction station and its gauge

const pad = n => String(n).padStart(2, '0')
// 'yyyyMMdd HH:mm' in GMT
function noaaTime (t) {
  const d = new Date(t)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
// '2026-10-15 15:30' (GMT) -> Date
const readTime = s => new Date(`${String(s).replace(' ', 'T')}:00Z`)

function readStations (body, gauges) {
  return ((body && body.stations) || [])
    .filter(s => s && s.id && typeof s.lat === 'number' && typeof s.lng === 'number' && (!gauges || (s.tidal !== false && s.greatlakes !== true)))
    .map(s => ({ id: String(s.id), name: String(s.name || s.id), latitude: s.lat, longitude: s.lng, type: s.type || null }))
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function data (ctx, params, what) {
    const url = buildUrl(ctx.options.noaaApiUrl || DATA_URL, Object.assign({
      application: 'signalk-tides-api', datum: DATUM, time_zone: 'gmt', units: 'metric', format: 'json'
    }, params))
    ctx.debug(`GET ${url}`)
    const fail = message => {
      // e.g. 'No data was found.', 'The station is not a valid station ...'
      throw noData(`NOAA: ${String(message || 'no data').trim()} (${what})`)
    }
    return getJson(url).then(body => {
      if (body && body.error) fail(body.error.message)
      return body || {}
    }, err => {
      const m = /"message"\s*:\s*"([^"]*)"/.exec(err.message)
      if (/HTTP 400/.test(err.message)) fail(m ? m[1] : err.message)
      throw err
    })
  }

  // missing values come as "" (which Number() would read as 0)
  function series (rows) {
    return (rows || []).map(r => ({ time: readTime(r.t), value: r.v === '' || r.v === null || r.v === undefined ? NaN : Number(r.v), type: r.type }))
      .filter(p => !isNaN(p.time.getTime()) && isFinite(p.value)).sort((a, b) => a.time - b.time)
  }

  function plan (ctx) {
    const list = ctx.state['stations:noaa-stations']
    const gauges = ctx.state['stations:noaa-gauges']
    if (!list || !gauges) return
    const maxDistance = maxDistanceOption(ctx, 'noaaMaxDistanceKm', 50)
    const found = nearest(list.stations, ctx.position)
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no NOAA tide station within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const g = nearest(gauges.stations, station)
    const gauge = ctx.state.gauge = g && g.distance <= GAUGE_MATCH ? g.item : null
    const s = ctx.state
    const t = ctx.t
    const mine = key => stationData(s, key, station.id)

    if (runningOut(mine('extremes'), t, DAY)) {
      ctx.job('extremes', 'high and low waters', () => data(ctx, {
        product: 'predictions', interval: 'hilo', station: station.id, begin_date: noaaTime(t - HOUR), range: 7 * 24 + 1
      }, `high and low waters at ${station.name}`).then(body => {
        const points = series(body.predictions).map(p => ({ time: p.time, value: p.value, flag: p.type === 'H' ? 'high' : p.type === 'L' ? 'low' : '' }))
          .filter(p => p.flag)
        if (points.length === 0) throw noData(`no high and low waters at ${station.name}`)
        s.extremes = { stationId: station.id, fetchedAt: t, points }
      }))
    }
    // subordinate stations have highs and lows only
    if (station.type !== 'S' && runningOut(mine('predicted'), t, 6 * HOUR)) {
      ctx.job('predicted', 'predicted level', () => data(ctx, {
        product: 'predictions', interval: 6, station: station.id, begin_date: noaaTime(t - HOUR), range: 49
      }, `predicted level at ${station.name}`).then(body => {
        s.predicted = { stationId: station.id, fetchedAt: t, points: series(body.predictions) }
      }))
    }
    const observed = mine('observed')
    if (gauge && (!observed || t - observed.fetchedAt >= ctx.refreshMs)) {
      ctx.job('observed', 'measured level', () => data(ctx, {
        product: 'water_level', station: gauge.id, begin_date: noaaTime(t - 2 * HOUR), range: 2
      }, `water level at ${gauge.name}`).then(body => {
        s.observed = { stationId: station.id, fetchedAt: t, points: series(body.data) }
      }))
    }
  }

  const spec = {
    optionKey: 'noaa',
    title: 'NOAA (US only)',
    name: 'NOAA',
    attribution: 'NOAA CO-OPS (public domain)',
    refreshKey: 'noaaRefreshMinutes',
    defaultRefreshMinutes: 6,
    minRefreshMinutes: 6,
    maxObservationAgeMinutes: 60,
    properties: {
      noaaRefreshMinutes: {
        type: 'number',
        title: 'NOAA: minutes between measured level updates (minimum 6)',
        default: 6
      },
      noaaMaxDistanceKm: {
        type: 'number',
        title: 'NOAA: use the nearest tide station within this distance (km)',
        default: 50
      }
    },
    update (ctx) {
      const meta = (ctx.options.noaaMetaUrl || META_URL).replace(/\/+$/, '')
      const fetchList = (type, gauges) => () => {
        const url = `${meta}/stations.json?type=${type}`
        ctx.debug(`GET ${url}`)
        return getJson(url).then(body => readStations(body, gauges))
      }
      const list = stationList(ctx, 'noaa-stations', 30 * DAY, fetchList('tidepredictions', false))
      const gauges = stationList(ctx, 'noaa-gauges', 30 * DAY, fetchList('waterlevels', true))
      if (list && gauges) plan(ctx)
      else ctx.job('plan', 'station', () => plan(ctx))
    },
    view (ctx) {
      const station = ctx.state.station
      if (!station) return null
      const gauge = ctx.state.gauge
      const points = key => (stationData(ctx.state, key, station.id) || {}).points
      return {
        station: { id: station.id, name: station.name, latitude: station.latitude, longitude: station.longitude },
        datum: DATUM,
        extremes: points('extremes'),
        predicted: points('predicted'),
        observed: points('observed'),
        attribution: `NOAA CO-OPS (public domain)${gauge && gauge.id !== station.id ? `, measured at ${gauge.name}` : ''}`
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DATA_URL = DATA_URL
module.exports.META_URL = META_URL
module.exports.noaaTime = noaaTime
module.exports.readStations = readStations
