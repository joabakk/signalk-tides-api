/*
 * Canadian Hydrographic Service (Fisheries and Oceans Canada), IWLS API:
 * https://api-iwls.dfo-mpo.gc.ca/swagger-ui.html
 *
 * Per station, time series by code:
 *   wlp-hilo  predicted high and low waters     wlp  predicted water level
 *   wlo       measured water level              wlf  forecast water level (some stations)
 * Heights in metres above chart datum. Free under CHS's licence, which is for non-commercial use;
 * not for navigation. Rate limit 3 requests a second, 30 a minute: this provider makes a few an
 * hour, one at a time.
 *
 * Requests: the station list once a month (kept in a file), highs and lows for 7 days and the
 * predicted level for 2 days only when they run out, the measured level at the refresh interval
 * (default 10 min) and the forecast hourly.
 */

const createProvider = require('../lib/tide-provider')
const { http, buildUrl, noData, quiet, nearest, stationList, maxDistance: maxDistanceOption, stationData, lastTime, HOUR, DAY } = createProvider

const DEFAULT_API_URL = 'https://api-iwls.dfo-mpo.gc.ca/api/v1'
const STATIONS_MAX_AGE = 30 * DAY

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function apiUrl (ctx) {
    return (ctx.options.chsApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function iso (t) {
    return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }

  function series (ctx, station, code, from, to) {
    const url = buildUrl(`${apiUrl(ctx)}/stations/${encodeURIComponent(station.id)}/data`, {
      'time-series-code': code, from: iso(from), to: iso(to)
    })
    ctx.debug(`GET ${url}`)
    return getJson(url).then(rows => {
      if (!Array.isArray(rows)) throw new Error(`unexpected answer for ${code}`)
      return rows
        .map(r => ({ time: new Date(r.eventDate), value: Number(r.value) }))
        .filter(p => !isNaN(p.time.getTime()) && isFinite(p.value))
        .sort((a, b) => a.time - b.time)
    }, err => {
      if (/HTTP 404/.test(err.message)) throw noData(`no ${code} data for station ${station.name}`)
      throw err
    })
  }

  // wlp-hilo doesn't say which is high: a value above its neighbour is a high.
  function typeExtremes (points) {
    return points.map((p, i) => {
      const other = points[i > 0 ? i - 1 : i + 1]
      const high = other ? p.value > other.value : true
      return Object.assign({}, p, { flag: high ? 'high' : 'low' })
    })
  }

  function plan (ctx) {
    const list = ctx.state['stations:chs-stations']
    if (!list) return
    const maxDistance = maxDistanceOption(ctx, 'chsMaxDistanceKm', 50)
    const found = nearest(list.stations, ctx.position, s => s.series.includes('wlp-hilo') || s.series.includes('wlp'))
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no CHS station within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const s = ctx.state
    const t = ctx.t
    const mine = key => stationData(s, key, station.id)

    if (station.series.includes('wlp-hilo') && lastTime(mine('extremes')) - t < DAY) {
      ctx.job('extremes', 'high and low waters', () => series(ctx, station, 'wlp-hilo', t - HOUR, t + 7 * DAY).then(points => {
        if (points.length === 0) throw noData(`no predicted high and low waters for ${station.name}`)
        s.extremes = { stationId: station.id, points: typeExtremes(points) }
      }))
    }
    if (station.series.includes('wlp') && lastTime(mine('predicted')) - t < 6 * HOUR) {
      ctx.job('predicted', 'predicted water level', () => series(ctx, station, 'wlp', t - HOUR, t + 2 * DAY).then(points => {
        if (points.length === 0) throw noData(`no predicted water level for ${station.name}`)
        s.predicted = { stationId: station.id, points }
      }))
    }
    const observed = mine('observed')
    if (station.series.includes('wlo') && (!observed || t - observed.fetchedAt >= ctx.refreshMs)) {
      ctx.job('observed', 'measured water level', () => series(ctx, station, 'wlo', t - HOUR, t).then(points => {
        s.observed = { stationId: station.id, points, fetchedAt: t }
      }))
    }
    const forecast = mine('forecast')
    if (station.series.includes('wlf') && (!forecast || t - forecast.fetchedAt >= HOUR)) {
      ctx.job('forecast', 'forecast water level', () => series(ctx, station, 'wlf', t - HOUR, t + 2 * DAY).then(points => {
        s.forecast = { stationId: station.id, points, fetchedAt: t }
      }))
    }
  }

  const spec = {
    optionKey: 'chs',
    title: 'CHS (Canada)',
    name: 'CHS',
    attribution: 'Fisheries and Oceans Canada, Canadian Hydrographic Service (non-commercial licence, not for navigation)',
    refreshKey: 'chsRefreshMinutes',
    defaultRefreshMinutes: 10,
    minRefreshMinutes: 5,
    maxObservationAgeMinutes: 60,
    properties: {
      chsRefreshMinutes: {
        type: 'number',
        title: 'CHS: minutes between measured water level updates (minimum 5)',
        default: 10
      },
      chsMaxDistanceKm: {
        type: 'number',
        title: 'CHS: use the nearest station within this distance (km)',
        default: 50
      },
      chsApiUrl: {
        type: 'string',
        title: 'CHS: API address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const list = stationList(ctx, 'chs-stations', STATIONS_MAX_AGE, () => {
        const url = `${apiUrl(ctx)}/stations`
        ctx.debug(`GET ${url}`)
        return getJson(url).then(rows => (Array.isArray(rows) ? rows : [])
          .filter(r => r && r.id && typeof r.latitude === 'number' && typeof r.longitude === 'number')
          .map(r => ({
            id: String(r.id),
            code: String(r.code || ''),
            name: String(r.officialName || r.code || r.id),
            latitude: r.latitude,
            longitude: r.longitude,
            series: (r.timeSeries || []).map(ts => ts && ts.code).filter(Boolean)
          })))
      })
      if (list) plan(ctx)
      else ctx.job('plan', 'station', () => plan(ctx))
    },
    view (ctx) {
      const station = ctx.state.station
      if (!station) return null
      const mine = key => (stationData(ctx.state, key, station.id) || {}).points
      return {
        station: { id: station.code || station.id, name: station.name, latitude: station.latitude, longitude: station.longitude },
        datum: 'CD',
        extremes: mine('extremes'),
        predicted: mine('predicted'),
        observed: mine('observed'),
        forecast: mine('forecast')
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
