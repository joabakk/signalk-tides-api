/*
 * SMHI (Sweden) oceanographic observations, open data (no key):
 * https://opendata-download-ocobs.smhi.se/api/version/1.0
 *
 * Measured sea level only: SMHI's open data has no tide predictions. Parameters (unit cm):
 *    6  Havsvattenstånd                 hourly, RH2000 (the Swedish height datum)
 *   13  Havsvattenstånd, minutvärde     every minute, RH2000
 *   12  Havsvattenstånd, RW timvärde    hourly, relative to the station's mean water level (MW = 0)
 *   14  Havsvattenstånd, RW minutvärde  every minute, relative to mean water level
 * Data: SMHI, CC BY 4.0. Values are not quality controlled (quality code O).
 *
 * The data comes with a delay of one to two hours.
 *
 * Requests: the station list weekly (kept in a file), and the latest hour of minute values at the
 * refresh interval (default 10 min). If a station has no minute values, the latest day of hourly
 * values is used for it instead (for an hour when the latest hour is still empty).
 */

const createProvider = require('../lib/tide-provider')
const { http, noData, quiet, nearest, stationList, maxDistance: maxDistanceOption, HOUR, DAY } = createProvider

const DEFAULT_API_URL = 'https://opendata-download-ocobs.smhi.se/api/version/1.0'
const STATIONS_MAX_AGE = 7 * DAY
const STALE_STATION = 7 * DAY // stations that have not reported for a week are left out
const PARAMETERS = {
  RH2000: { minute: 13, hourly: 6 },
  MW: { minute: 14, hourly: 12 }
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function apiUrl (ctx) {
    return (ctx.options.smhiApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function datum (ctx) {
    return ctx.options.smhiDatum === 'MW' ? 'MW' : 'RH2000'
  }

  function readStations (body, t) {
    return ((body && body.station) || [])
      .filter(s => s && s.active !== false && s.key && typeof s.latitude === 'number' && typeof s.longitude === 'number' &&
        !(typeof s.updated === 'number' && t - s.updated > STALE_STATION))
      .map(s => ({ id: String(s.key), name: String(s.name || s.key), latitude: s.latitude, longitude: s.longitude }))
  }

  function readValues (body) {
    return ((body && body.value) || [])
      .filter(v => v && typeof v.value === 'number' && typeof v.date === 'number')
      .map(v => ({ time: new Date(v.date), value: v.value / 100 }))
      .sort((a, b) => a.time - b.time)
  }

  function values (ctx, parameter, station, period) {
    const url = `${apiUrl(ctx)}/parameter/${parameter}/station/${encodeURIComponent(station.id)}/period/${period}/data.json`
    ctx.debug(`GET ${url}`)
    return getJson(url).then(readValues, err => {
      if (/HTTP 404/.test(err.message)) return null
      throw err
    })
  }

  function plan (ctx) {
    const d = datum(ctx)
    const list = ctx.state[`stations:smhi-stations-${d}`]
    if (!list) return
    const maxDistance = maxDistanceOption(ctx, 'smhiMaxDistanceKm', 30)
    const found = nearest(list.stations, ctx.position)
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no SMHI sea level station within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const s = ctx.state
    const t = ctx.t
    const observed = s.observed && s.observed.stationId === station.id && s.observed.datum === d ? s.observed : null
    if (observed && t - observed.fetchedAt < ctx.refreshMs) return
    // until when to skip minute values: for good after a 404 (none at this station), for an hour
    // after an empty latest hour (SMHI's delay), so that each update makes one request
    const hourlyUntil = s.hourlyUntil || (s.hourlyUntil = {})
    const key = `${d}:${station.id}`
    ctx.job('observed', 'measured sea level', () => {
      const hourly = () => values(ctx, PARAMETERS[d].hourly, station, 'latest-day')
      const fetch = t < (hourlyUntil[key] || 0) ? hourly() : values(ctx, PARAMETERS[d].minute, station, 'latest-hour').then(points => {
        if (points && points.length) return points
        hourlyUntil[key] = points ? t + HOUR : Infinity
        return hourly()
      })
      return fetch.then(points => {
        if (!points || points.length === 0) throw noData(`no recent sea level at ${station.name}`)
        s.observed = { stationId: station.id, datum: d, points, fetchedAt: t }
      })
    })
  }

  const spec = {
    optionKey: 'smhi',
    title: 'SMHI (Sweden, measured sea level)',
    name: 'SMHI',
    attribution: 'SMHI (CC BY 4.0), measured sea level, not quality controlled; no predictions',
    refreshKey: 'smhiRefreshMinutes',
    defaultRefreshMinutes: 10,
    minRefreshMinutes: 5,
    maxObservationAgeMinutes: 180, // SMHI publishes with a delay of one to two hours
    forecast: false,
    properties: {
      smhiDatum: {
        type: 'string',
        title: 'SMHI: reference level (zero) for heights',
        enum: ['RH2000', 'MW'],
        enumNames: ['RH2000 (Swedish height datum)', "Station's mean water level (MW)"],
        default: 'RH2000'
      },
      smhiRefreshMinutes: {
        type: 'number',
        title: 'SMHI: minutes between updates (minimum 5)',
        default: 10
      },
      smhiMaxDistanceKm: {
        type: 'number',
        title: 'SMHI: use the nearest station within this distance (km)',
        default: 30
      },
      smhiApiUrl: {
        type: 'string',
        title: 'SMHI: API address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const d = datum(ctx)
      const list = stationList(ctx, `smhi-stations-${d}`, STATIONS_MAX_AGE, () => {
        const url = `${apiUrl(ctx)}/parameter/${PARAMETERS[d].hourly}.json`
        ctx.debug(`GET ${url}`)
        return getJson(url).then(body => readStations(body, ctx.t))
      })
      if (list) plan(ctx)
      else ctx.job('plan', 'station', () => plan(ctx))
    },
    view (ctx) {
      const station = ctx.state.station
      const observed = ctx.state.observed
      if (!station) return null
      return {
        station: { id: station.id, name: station.name, latitude: station.latitude, longitude: station.longitude },
        datum: datum(ctx),
        observed: observed && observed.stationId === station.id && observed.datum === datum(ctx) ? observed.points : undefined
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
