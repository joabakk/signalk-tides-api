/*
 * PEGELONLINE (Germany, Federal Waterways and Shipping Administration WSV), REST API v2 (no key):
 * https://www.pegelonline.wsv.de/webservices/rest-api/v2
 *
 *   stations.json?includeTimeseries=true    all gauges, their series and gauge zero (PNP) in
 *                                           m above NHN (or the older NN)
 *   stations/{uuid}/W/measurements.json     water level W, cm above the gauge zero, every minute
 *                                           on the coast
 *
 * Measured water level only: PEGELONLINE has no tide predictions (the BSH's have no open API).
 * Heights above NHN (the German height datum, close to mean sea level) by default: W / 100 plus
 * the gauge zero. Coastal gauge zeros lie about 5 m below NHN, so levels above the gauge zero are
 * around 5 m. Neither is chart datum. Data: WSV, Data licence Germany - Zero 2.0.
 *
 * Requests: the station list weekly (kept in a file), and the last 2 hours of W at the refresh
 * interval (default 10 min).
 */

const createProvider = require('../lib/tide-provider')
const { http, noData, quiet, nearest, stationList, maxDistance: maxDistanceOption, DAY } = createProvider

const DEFAULT_API_URL = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2'

const titleCase = s => String(s).toLowerCase().replace(/(^|[\s\-(/.])(\S)/g, (m, a, b) => a + b.toUpperCase())

function readStations (list) {
  return (Array.isArray(list) ? list : []).map(s => {
    const w = (s && s.timeseries || []).find(t => t && t.shortname === 'W' && t.unit === 'cm')
    const zero = w && w.gaugeZero
    if (!w || typeof s.latitude !== 'number' || typeof s.longitude !== 'number') return null
    return {
      id: String(s.uuid),
      name: titleCase(s.longname || s.shortname),
      water: s.water && s.water.longname ? titleCase(s.water.longname) : '',
      latitude: s.latitude,
      longitude: s.longitude,
      // m above NHN, or NN on a few old gauges (within centimetres of NHN)
      gaugeZero: zero && typeof zero.value === 'number' && /N(H)?N/.test(zero.unit || '') ? zero.value : null,
      gaugeZeroUnit: zero ? zero.unit : null
    }
  }).filter(Boolean)
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function apiUrl (ctx) {
    return (ctx.options.germanyApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function datum (ctx) {
    return ctx.options.germanyDatum === 'gauge' ? 'gauge' : 'NHN'
  }

  function plan (ctx) {
    const list = ctx.state['stations:germany-stations']
    if (!list) return
    const d = datum(ctx)
    const maxDistance = maxDistanceOption(ctx, 'germanyMaxDistanceKm', 10)
    // in NHN only gauges whose zero is known
    const found = nearest(list.stations, ctx.position, s => d === 'gauge' || s.gaugeZero !== null)
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no PEGELONLINE gauge within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const s = ctx.state
    const t = ctx.t
    const observed = s.observed && s.observed.stationId === station.id ? s.observed : null
    if (observed && t - observed.fetchedAt < ctx.refreshMs) return
    ctx.job('observed', 'measured water level', () => {
      const url = `${apiUrl(ctx)}/stations/${encodeURIComponent(station.id)}/W/measurements.json?start=PT2H`
      ctx.debug(`GET ${url}`)
      return getJson(url).then(rows => {
        if (!Array.isArray(rows)) throw new Error('unexpected answer for W')
        const points = rows.map(r => ({ time: new Date(r && r.timestamp), value: Number(r && r.value) / 100 }))
          .filter(p => !isNaN(p.time.getTime()) && isFinite(p.value)).sort((a, b) => a.time - b.time)
        s.observed = { stationId: station.id, points, fetchedAt: t }
      }, err => {
        if (/HTTP 404/.test(err.message)) throw noData(`no water level at ${station.name}`)
        throw err
      })
    })
  }

  const spec = {
    optionKey: 'germany',
    title: 'PEGELONLINE (Germany, measured water level)',
    name: 'PEGELONLINE',
    attribution: 'WSV, PEGELONLINE (dl-de/zero-2-0); measured water level, no predictions',
    refreshKey: 'germanyRefreshMinutes',
    defaultRefreshMinutes: 10,
    minRefreshMinutes: 5,
    maxObservationAgeMinutes: 60,
    forecast: false,
    properties: {
      germanyDatum: {
        type: 'string',
        title: 'PEGELONLINE: reference level (zero) for heights',
        enum: ['NHN', 'gauge'],
        enumNames: ['NHN (German height datum, close to mean sea level)', "Gauge zero (PNP, the gauge's own zero)"],
        default: 'NHN'
      },
      germanyRefreshMinutes: {
        type: 'number',
        title: 'PEGELONLINE: minutes between updates (minimum 5)',
        default: 10
      },
      germanyMaxDistanceKm: {
        type: 'number',
        title: 'PEGELONLINE: use the nearest gauge within this distance (km)',
        default: 10
      },
      germanyApiUrl: {
        type: 'string',
        title: 'PEGELONLINE: API address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const list = stationList(ctx, 'germany-stations', 7 * DAY, () => {
        const url = `${apiUrl(ctx)}/stations.json?includeTimeseries=true`
        ctx.debug(`GET ${url}`)
        return getJson(url).then(readStations)
      })
      if (list) plan(ctx)
      else ctx.job('plan', 'station', () => plan(ctx))
    },
    view (ctx) {
      const station = ctx.state.station
      if (!station) return null
      const d = datum(ctx)
      const observed = ctx.state.observed && ctx.state.observed.stationId === station.id ? ctx.state.observed.points : undefined
      const shift = d === 'gauge' ? 0 : station.gaugeZero
      const where = station.water ? ` (${station.water})` : ''
      return {
        station: { id: station.id, name: `${station.name}${where}`, latitude: station.latitude, longitude: station.longitude },
        datum: d === 'gauge' ? 'gauge zero' : 'NHN',
        observed: observed && shift !== null ? observed.map(p => ({ time: p.time, value: p.value + shift })) : undefined
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.readStations = readStations
