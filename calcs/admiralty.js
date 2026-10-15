/*
 * UK Hydrographic Office, Admiralty UK Tidal API (key needed, free "Discovery" tier):
 * https://admiraltyapi.portal.azure-api.net
 *
 *   GET {api}/Stations                          about 600 UK and Irish ports, GeoJSON features
 *                                               (properties Id, Name, Country; geometry [lon, lat])
 *   GET {api}/Stations/{id}/TidalEvents?duration=7
 *                                               high and low waters: EventType HighWater/LowWater,
 *                                               DateTime (UTC, without 'Z'), Height (m above chart
 *                                               datum), IsApproximateTime/Height
 * The key goes in the Ocp-Apim-Subscription-Key header. The Discovery tier gives 7 days of highs and
 * lows and a limited number of calls a month; this provider asks for them once a day. The UKHO's
 * terms apply to the key holder. Predictions only: no measurements.
 *
 * Status: built from the API's documentation; not yet checked against a real response.
 */

const createProvider = require('../lib/tide-provider')
const { http, noData, quiet, nearest, stationList, maxDistance: maxDistanceOption, stationData, runningOut, DAY } = createProvider

const DEFAULT_API_URL = 'https://admiraltyapi.azure-api.net/uktidalapi/api/V1'

// '2026-10-15T21:24:00' (UTC, no zone) or with a zone -> Date
const readTime = s => new Date(/(Z|[+-]\d\d:?\d\d)$/.test(String(s)) ? s : `${s}Z`)

function readStations (body) {
  return ((body && body.features) || []).map(f => {
    const p = f && f.properties
    const c = f && f.geometry && f.geometry.coordinates
    if (!p || !p.Id || !Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null
    const name = String(p.Name || p.Id).toLowerCase().replace(/(^|[\s\-(/.'])(\S)/g, (m, a, b) => a + b.toUpperCase())
    return { id: String(p.Id), name, latitude: c[1], longitude: c[0] }
  }).filter(Boolean)
}

function readEvents (body) {
  return (Array.isArray(body) ? body : []).map(e => ({
    time: readTime(e && e.DateTime),
    value: Number(e && e.Height),
    flag: e && e.EventType === 'HighWater' ? 'high' : e && e.EventType === 'LowWater' ? 'low' : ''
  })).filter(p => p.flag && !isNaN(p.time.getTime()) && isFinite(p.value)).sort((a, b) => a.time - b.time)
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function apiUrl (ctx) {
    return (ctx.options.admiraltyApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function get (ctx, path, what) {
    const url = `${apiUrl(ctx)}${path}`
    ctx.debug(`GET ${url}`)
    return getJson(url, { 'Ocp-Apim-Subscription-Key': String(ctx.options.admiraltyApiKey).trim() }).catch(err => {
      if (/HTTP 401/.test(err.message)) throw new Error('the API key was refused (HTTP 401): check the Admiralty API key in the settings')
      if (/HTTP 403/.test(err.message)) throw new Error('the API key is not allowed this (HTTP 403): check its subscription and monthly quota')
      if (/HTTP 404/.test(err.message)) throw noData(`no ${what}`)
      throw err
    })
  }

  function plan (ctx) {
    const list = ctx.state['stations:admiralty-stations']
    if (!list) return
    const maxDistance = maxDistanceOption(ctx, 'admiraltyMaxDistanceKm', 30)
    const found = nearest(list.stations, ctx.position)
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no Admiralty tide station within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const s = ctx.state
    const t = ctx.t
    // 7 days are asked for; asked again when less than 6 days remain (about once a day)
    if (runningOut(stationData(s, 'extremes', station.id), t, 6 * DAY)) {
      ctx.job('extremes', 'high and low waters', () => get(ctx, `/Stations/${encodeURIComponent(station.id)}/TidalEvents?duration=7`,
        `high and low waters for ${station.name}`).then(body => {
        const points = readEvents(body)
        if (points.length === 0) throw noData(`no high and low waters for ${station.name}`)
        s.extremes = { stationId: station.id, fetchedAt: t, points }
      }))
    }
  }

  const spec = {
    optionKey: 'admiralty',
    title: 'Admiralty (UK, API key needed)',
    name: 'Admiralty',
    attribution: 'UK Hydrographic Office, Admiralty UK Tidal API (key holder\'s licence)',
    defaultRefreshMinutes: 60,
    properties: {
      admiraltyApiKey: {
        type: 'string',
        title: 'Admiralty: API key (UK Tidal API - Discovery, free at admiraltyapi.portal.azure-api.net)',
        default: ''
      },
      admiraltyMaxDistanceKm: {
        type: 'number',
        title: 'Admiralty: use the nearest tide station within this distance (km)',
        default: 30
      },
      admiraltyApiUrl: {
        type: 'string',
        title: 'Admiralty: API address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      if (!String(ctx.options.admiraltyApiKey || '').trim()) {
        const message = 'no API key: enter your Admiralty UK Tidal API key in the plugin settings'
        // reported once, not at every update
        if (ctx.state.noKeyReported) throw quiet(message)
        ctx.state.noKeyReported = true
        throw new Error(message)
      }
      const list = stationList(ctx, 'admiralty-stations', 30 * DAY, () => get(ctx, '/Stations', 'stations').then(readStations))
      if (list) plan(ctx)
      else ctx.job('plan', 'station', () => plan(ctx))
    },
    view (ctx) {
      const station = ctx.state.station
      if (!station) return null
      return {
        station: { id: station.id, name: station.name, latitude: station.latitude, longitude: station.longitude },
        datum: 'CD',
        extremes: (stationData(ctx.state, 'extremes', station.id) || {}).points
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.readStations = readStations
module.exports.readEvents = readEvents
