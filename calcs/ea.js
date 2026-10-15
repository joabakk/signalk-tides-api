/*
 * Environment Agency (England), flood monitoring API (no key):
 * https://environment.data.gov.uk/flood-monitoring/doc/reference
 *
 *   id/stations?type=TideGauge         about 90 tide gauge entries, each with one measure: 15-minute
 *                                      mean level in mAOD (above Ordnance Datum Newlyn) or in m above
 *                                      the gauge's local datum. A gauge usually appears twice, once
 *                                      per datum, under two station references at the same place.
 *   id/stations/{ref}/readings         the latest readings, newest first
 *
 * Measured level only: no predictions. EA doesn't name the local datum; at Dover its values match
 * chart datum. The two gauges given in mm without a datum are left out.
 * Data: Environment Agency, Open Government Licence v3; status: beta service.
 *
 * Requests: the gauge list weekly (kept in a file), and the latest 3 hours of readings at the
 * refresh interval (default 15 min, the gauges' interval). Readings arrive about 45 minutes late.
 */

const createProvider = require('../lib/tide-provider')
const { http, noData, quiet, nearest, stationList, maxDistance: maxDistanceOption, DAY } = createProvider

const DEFAULT_API_URL = 'https://environment.data.gov.uk/flood-monitoring'
const UNITS = { mAOD: 'AOD', m: 'local' }

function readGauges (body) {
  return ((body && body.items) || []).map(s => {
    const measures = Array.isArray(s.measures) ? s.measures : s.measures ? [s.measures] : []
    const m = measures.find(m => m && UNITS[m.unitName] && m.parameter === 'level')
    if (!m || typeof s.lat !== 'number' || typeof s.long !== 'number' || !s.stationReference) return null
    return { id: String(s.stationReference), name: String(s.label || s.stationReference), latitude: s.lat, longitude: s.long, datum: UNITS[m.unitName] }
  }).filter(Boolean)
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function apiUrl (ctx) {
    return (ctx.options.eaApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function datum (ctx) {
    return ctx.options.eaDatum === 'local' ? 'local' : 'AOD'
  }

  function plan (ctx) {
    const list = ctx.state['stations:ea-gauges']
    if (!list) return
    const d = datum(ctx)
    const maxDistance = maxDistanceOption(ctx, 'eaMaxDistanceKm', 15)
    const found = nearest(list.stations, ctx.position, g => g.datum === d)
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no Environment Agency tide gauge (${d === 'AOD' ? 'mAOD' : 'local datum'}) within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const s = ctx.state
    const t = ctx.t
    const observed = s.observed && s.observed.stationId === station.id ? s.observed : null
    if (observed && t - observed.fetchedAt < ctx.refreshMs) return
    ctx.job('observed', 'measured level', () => {
      const url = `${apiUrl(ctx)}/id/stations/${encodeURIComponent(station.id)}/readings?_sorted&_limit=12`
      ctx.debug(`GET ${url}`)
      return getJson(url).then(body => {
        const points = ((body && body.items) || []).map(r => ({ time: new Date(r && r.dateTime), value: Number(r && r.value) }))
          .filter(p => !isNaN(p.time.getTime()) && isFinite(p.value)).sort((a, b) => a.time - b.time)
        s.observed = { stationId: station.id, points, fetchedAt: t }
      }, err => {
        if (/HTTP 404/.test(err.message)) throw noData(`no readings at ${station.name}`)
        throw err
      })
    })
  }

  const spec = {
    optionKey: 'ea',
    title: 'Environment Agency (England, measured tide level)',
    name: 'Environment Agency',
    attribution: 'Environment Agency (Open Government Licence v3); measured level, no predictions',
    refreshKey: 'eaRefreshMinutes',
    defaultRefreshMinutes: 15,
    minRefreshMinutes: 15,
    maxObservationAgeMinutes: 120, // 15-minute means, published about 45 minutes late
    forecast: false,
    properties: {
      eaDatum: {
        type: 'string',
        title: 'Environment Agency: reference level (zero) for heights',
        enum: ['AOD', 'local'],
        enumNames: ['Ordnance Datum Newlyn (mAOD)', "The gauge's local datum (often chart datum)"],
        default: 'AOD'
      },
      eaRefreshMinutes: {
        type: 'number',
        title: 'Environment Agency: minutes between updates (minimum 15)',
        default: 15
      },
      eaMaxDistanceKm: {
        type: 'number',
        title: 'Environment Agency: use the nearest tide gauge within this distance (km)',
        default: 15
      },
      eaApiUrl: {
        type: 'string',
        title: 'Environment Agency: API address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const list = stationList(ctx, 'ea-gauges', 7 * DAY, () => {
        const url = `${apiUrl(ctx)}/id/stations?type=TideGauge`
        ctx.debug(`GET ${url}`)
        return getJson(url).then(readGauges)
      })
      if (list) plan(ctx)
      else ctx.job('plan', 'station', () => plan(ctx))
    },
    view (ctx) {
      const station = ctx.state.station
      if (!station) return null
      const observed = ctx.state.observed && ctx.state.observed.stationId === station.id ? ctx.state.observed.points : undefined
      return {
        station: { id: station.id, name: station.name, latitude: station.latitude, longitude: station.longitude },
        datum: station.datum === 'AOD' ? 'AOD' : 'local datum',
        observed
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.readGauges = readGauges
