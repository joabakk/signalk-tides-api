/*
 * IOC Sea Level Station Monitoring Facility (UNESCO/IOC, run by VLIZ), worldwide (no key):
 * https://www.ioc-sealevelmonitoring.org
 *
 *   service.php?query=stationlist&showall=all   one row per station and sensor: Code, Location, Lat,
 *                                               Lon, sensor, lasttime (UTC)
 *   service.php?query=data&code=X&timestart=2026-10-19T10:25:04&timestop=...&format=json
 *                                               [{ slevel (m), stime 'YYYY-MM-DD hh:mm:ss' UTC,
 *                                               sensor }]; times without a zone ('Z' is refused)
 *
 * Measured sea level only, raw and not quality controlled, relative to each gauge's own zero: it is
 * not tied to chart datum or a height system, so the level can't be compared with other providers'.
 * Useful far from national services, for the trend and the effect of weather. A fallback like
 * Open-Meteo: it publishes nothing while a station-based provider does. Data: IOC SLSMF; please
 * acknowledge the facility and the station operators.
 *
 * Requests: the station list monthly (2.4 MB; only the fields used are kept in a file), and the last
 * 3 hours of the nearest gauge at the refresh interval (default 10 min).
 */

const createProvider = require('../lib/tide-provider')
const { http, buildUrl, quiet, nearest, stationList, maxDistance: maxDistanceOption, HOUR, DAY } = createProvider

const DEFAULT_API_URL = 'https://www.ioc-sealevelmonitoring.org/service.php'
// water level sensors, best first (radar, pressure, float, encoder, bubbler, ...); not 'bat' (battery
// voltage), 'atm' (air pressure) or others
const SENSORS = ['rad', 'prs', 'flt', 'enc', 'bub', 'pwl', 'wls', 'aqu', 'ra2', 'ras', 'pr1', 'pr2', 'prt', 'en2', 'bub1', 'bwl']
const STALE = 2 * DAY // gauges silent for longer at list time are left out

const utc = s => new Date(`${String(s).trim().replace(' ', 'T').replace(/\.\d+$/, '')}Z`)
const isoNoZone = t => new Date(t).toISOString().slice(0, 19)

function readStations (rows, t) {
  const byCode = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    const lat = Number(r && r.Lat)
    const lon = Number(r && r.Lon)
    if (!r || !r.Code || !SENSORS.includes(r.sensor) || !isFinite(lat) || !isFinite(lon)) continue
    const last = utc(r.lasttime)
    if (isNaN(last.getTime()) || t - last.getTime() > STALE) continue
    const s = byCode.get(r.Code) || { id: String(r.Code), name: String(r.Location || r.Code), latitude: lat, longitude: lon, sensors: [] }
    if (!s.sensors.includes(r.sensor)) s.sensors.push(r.sensor)
    byCode.set(r.Code, s)
  }
  return [...byCode.values()].map(s => Object.assign(s, { sensors: s.sensors.sort((a, b) => SENSORS.indexOf(a) - SENSORS.indexOf(b)) }))
}

// rows of the best water level sensor in the answer
function readLevels (rows) {
  const good = (Array.isArray(rows) ? rows : []).filter(r => r && SENSORS.includes(r.sensor) && typeof r.slevel === 'number' && isFinite(r.slevel))
  const sensor = SENSORS.find(s => good.some(r => r.sensor === s))
  return good.filter(r => r.sensor === sensor)
    .map(r => ({ time: utc(r.stime), value: r.slevel }))
    .filter(p => !isNaN(p.time.getTime())).sort((a, b) => a.time - b.time)
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function apiUrl (ctx) {
    return ctx.options.iocApiUrl || DEFAULT_API_URL
  }

  function plan (ctx) {
    const list = ctx.state['stations:ioc-stations']
    if (!list) return
    const maxDistance = maxDistanceOption(ctx, 'iocMaxDistanceKm', 30)
    const found = nearest(list.stations, ctx.position)
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no IOC sea level station within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const s = ctx.state
    const t = ctx.t
    const observed = s.observed && s.observed.stationId === station.id ? s.observed : null
    if (observed && t - observed.fetchedAt < ctx.refreshMs) return
    ctx.job('observed', 'measured sea level', () => {
      // built by hand: the times go as captured, with plain ':' (only digits, '-', ':' and 'T')
      const url = `${apiUrl(ctx)}?query=data&code=${encodeURIComponent(station.id)}&timestart=${isoNoZone(t - 3 * HOUR)}&timestop=${isoNoZone(t)}&format=json`
      ctx.debug(`GET ${url}`)
      return getJson(url).then(rows => {
        const error = Array.isArray(rows) && rows[0] && rows[0].error
        if (error) throw new Error(String(error))
        s.observed = { stationId: station.id, points: readLevels(rows), fetchedAt: t }
      })
    })
  }

  const spec = {
    optionKey: 'ioc',
    fallback: true, // raw levels on an unknown zero: quiet while a station-based provider publishes
    forecast: false,
    title: 'IOC sea level monitoring (worldwide, measured, raw)',
    name: 'IOC',
    attribution: 'IOC Sea Level Station Monitoring Facility; raw data, not quality controlled, gauge zero not referenced',
    refreshKey: 'iocRefreshMinutes',
    defaultRefreshMinutes: 10,
    minRefreshMinutes: 5,
    maxObservationAgeMinutes: 60,
    properties: {
      iocRefreshMinutes: {
        type: 'number',
        title: 'IOC: minutes between updates (minimum 5)',
        default: 10
      },
      iocMaxDistanceKm: {
        type: 'number',
        title: 'IOC: use the nearest sea level station within this distance (km)',
        default: 30
      },
      iocApiUrl: {
        type: 'string',
        title: 'IOC: service address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const list = stationList(ctx, 'ioc-stations', 30 * DAY, () => {
        const url = buildUrl(apiUrl(ctx), { query: 'stationlist', showall: 'all' })
        ctx.debug(`GET ${url}`)
        return getJson(url).then(rows => readStations(rows, ctx.t))
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
        datum: 'gauge zero, not referenced',
        observed
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.readStations = readStations
module.exports.readLevels = readLevels
