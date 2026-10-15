/*
 * Marine Institute (Ireland), ERDDAP (no key): https://erddap.marine.ie/erddap
 *
 *   IMI_TidePrediction_HighLow     high and low waters (HIGH/LOW), m above OD Malin
 *   imiTidePrediction              predicted level every 5 minutes, m above LAT (Water_Level) and
 *                                  OD Malin (Water_Level_ODM). Stations named X_MODELLED come from
 *                                  the Marine Institute's model; their high/low station is X.
 *   IrishNationalTideGaugeNetwork  measured level every 5 minutes at about 20 tide gauges, m above
 *                                  LAT and OD Malin, with a SeaDataNet quality flag
 * Data: Marine Institute, CC BY 4.0.
 *
 * Heights above LAT (the chart datum) by default; high and low waters are given above OD Malin
 * only and are shifted by the station's LAT - OD Malin difference from the predicted series.
 * Measurements come from a gauge within 5 km of the prediction station (names differ between the
 * datasets).
 *
 * Requests: the station and gauge lists monthly and weekly (kept in files), highs and lows for 7
 * days and the predicted level for 2 days only when they run out, and the gauge's last 2 hours at
 * the refresh interval (default 10 min).
 */

const createProvider = require('../lib/tide-provider')
const {
  http, noData, quiet, nearest, stationList, maxDistance: maxDistanceOption, stationData, runningOut, distance,
  HOUR, DAY
} = createProvider

const DEFAULT_API_URL = 'https://erddap.marine.ie/erddap/tabledap'
const PREDICTIONS = 'imiTidePrediction'
const HIGH_LOW = 'IMI_TidePrediction_HighLow'
const GAUGES = 'IrishNationalTideGaugeNetwork'
const GAUGE_MATCH = 5000 // m between a prediction station and its gauge
const GOOD_QUALITY = [0, 1, 2] // SeaDataNet: no check, good, probably good

// ERDDAP's JSON: { table: { columnNames, rows } } -> objects
function readTable (body) {
  const table = body && body.table
  if (!table || !Array.isArray(table.columnNames) || !Array.isArray(table.rows)) throw new Error('not an ERDDAP table')
  return table.rows.map(row => {
    const o = {}
    table.columnNames.forEach((name, i) => { o[name] = row[i] })
    return o
  })
}

const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
const quoted = v => encodeURIComponent(`"${v}"`)
const between = (from, to) => [`time%3E=${iso(from)}`, `time%3C=${iso(to)}`]

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function apiUrl (ctx) {
    return (ctx.options.irelandApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function datum (ctx) {
    return ctx.options.irelandDatum === 'ODM' ? 'ODM' : 'LAT'
  }

  function query (ctx, dataset, variables, constraints, what) {
    const url = `${apiUrl(ctx)}/${dataset}.json?${variables.join(',')}${constraints.map(c => `&${c}`).join('')}`
    ctx.debug(`GET ${url}`)
    return getJson(url).then(readTable, err => {
      // ERDDAP answers 404 when nothing matches
      if (/HTTP 404/.test(err.message)) throw noData(`no ${what}`)
      throw err
    })
  }

  const positions = rows => rows
    .map(r => ({ r, latitude: Number(r.latitude), longitude: Number(r.longitude) }))
    .filter(p => isFinite(p.latitude) && isFinite(p.longitude))

  function plan (ctx) {
    const list = ctx.state['stations:ireland-stations']
    const gauges = ctx.state['stations:ireland-gauges']
    if (!list || !gauges) return
    const maxDistance = maxDistanceOption(ctx, 'irelandMaxDistanceKm', 30)
    const found = nearest(list.stations, ctx.position)
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no Marine Institute tide station within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const gauge = nearest(gauges.stations, station)
    station.gauge = gauge && gauge.distance <= GAUGE_MATCH ? gauge.item : null
    const s = ctx.state
    const t = ctx.t
    const mine = key => stationData(s, key, station.id)

    if (runningOut(mine('extremes'), t, DAY)) {
      ctx.job('extremes', 'high and low waters', () => query(ctx, HIGH_LOW, ['time', 'tide_time_category', 'Water_Level_ODMalin'],
        [`stationID=${quoted(station.highLowId)}`, ...between(t - HOUR, t + 7 * DAY)], `high and low waters for ${station.name}`).then(rows => {
        const points = rows.map(r => ({
          time: new Date(r.time),
          value: Number(r.Water_Level_ODMalin),
          flag: /^high/i.test(r.tide_time_category) ? 'high' : /^low/i.test(r.tide_time_category) ? 'low' : ''
        })).filter(p => p.flag && isFinite(p.value) && !isNaN(p.time.getTime())).sort((a, b) => a.time - b.time)
        s.extremes = { stationId: station.id, fetchedAt: t, points }
      }))
    }
    if (runningOut(mine('predicted'), t, 6 * HOUR)) {
      ctx.job('predicted', 'predicted level', () => query(ctx, PREDICTIONS, ['time', 'Water_Level', 'Water_Level_ODM'],
        [`stationID=${quoted(station.id)}`, ...between(t - HOUR, t + 2 * DAY)], `predictions for ${station.name}`).then(rows => {
        const good = rows.map(r => ({ time: new Date(r.time), lat: Number(r.Water_Level), odm: Number(r.Water_Level_ODM) }))
          .filter(p => !isNaN(p.time.getTime()) && isFinite(p.lat) && isFinite(p.odm)).sort((a, b) => a.time - b.time)
        if (good.length === 0) throw noData(`no predictions for ${station.name}`)
        const offsets = good.map(p => p.lat - p.odm).sort((a, b) => a - b)
        s.predicted = {
          stationId: station.id,
          fetchedAt: t,
          points: good.map(p => ({ time: p.time, value: p.lat })),
          LAT: good.map(p => ({ time: p.time, value: p.lat })),
          ODM: good.map(p => ({ time: p.time, value: p.odm })),
          offset: offsets[Math.floor(offsets.length / 2)] // LAT - OD Malin, constant to the cm
        }
      }))
    }
    const observed = mine('observed')
    if (station.gauge && (!observed || t - observed.fetchedAt >= ctx.refreshMs)) {
      const gauge = station.gauge
      ctx.job('observed', 'measured level', () => query(ctx, GAUGES, ['time', 'Water_Level_LAT', 'Water_Level_OD_Malin', 'QC_Flag'],
        [`station_id=${quoted(gauge.id)}`, ...between(t - 2 * HOUR, t)], `recent measurements at ${gauge.name}`).catch(err => {
        if (err.noData) return [] // nothing in the last two hours: no measurement, not an error
        throw err
      }).then(rows => {
        const good = rows.filter(r => GOOD_QUALITY.includes(Number(r.QC_Flag)))
          .map(r => ({ time: new Date(r.time), lat: Number(r.Water_Level_LAT), odm: Number(r.Water_Level_OD_Malin) }))
          .filter(p => !isNaN(p.time.getTime()) && isFinite(p.lat) && isFinite(p.odm)).sort((a, b) => a.time - b.time)
        s.observed = {
          stationId: station.id,
          fetchedAt: t,
          LAT: good.map(p => ({ time: p.time, value: p.lat })),
          ODM: good.map(p => ({ time: p.time, value: p.odm }))
        }
      }))
    }
  }

  const spec = {
    optionKey: 'ireland',
    title: 'Marine Institute (Ireland)',
    name: 'Marine Institute',
    attribution: 'Marine Institute, Ireland (CC BY 4.0)',
    refreshKey: 'irelandRefreshMinutes',
    defaultRefreshMinutes: 10,
    minRefreshMinutes: 5,
    maxObservationAgeMinutes: 60,
    properties: {
      irelandDatum: {
        type: 'string',
        title: 'Marine Institute: reference level (zero) for heights',
        enum: ['LAT', 'ODM'],
        enumNames: ['Lowest astronomical tide (LAT, chart datum)', 'Ordnance Datum Malin'],
        default: 'LAT'
      },
      irelandRefreshMinutes: {
        type: 'number',
        title: 'Marine Institute: minutes between measured level updates (minimum 5)',
        default: 10
      },
      irelandMaxDistanceKm: {
        type: 'number',
        title: 'Marine Institute: use the nearest tide station within this distance (km)',
        default: 30
      },
      irelandApiUrl: {
        type: 'string',
        title: 'Marine Institute: ERDDAP tabledap address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const t = ctx.t
      const list = stationList(ctx, 'ireland-stations', 30 * DAY, () => query(ctx, PREDICTIONS, ['stationID', 'longitude', 'latitude'],
        [...between(t, t + HOUR), 'distinct()'], 'prediction stations').then(rows => positions(rows).map(p => ({
        id: String(p.r.stationID),
        highLowId: String(p.r.stationID).replace(/_MODELLED$/, ''),
        name: String(p.r.stationID).replace(/_MODELLED$/, '').replace(/_/g, ' '),
        latitude: p.latitude,
        longitude: p.longitude
      }))))
      const gauges = stationList(ctx, 'ireland-gauges', 7 * DAY, () => query(ctx, GAUGES, ['station_id', 'latitude', 'longitude'],
        [...between(t - DAY, t), 'distinct()'], 'tide gauges').then(rows => positions(rows).map(p => ({
        id: String(p.r.station_id), name: String(p.r.station_id), latitude: p.latitude, longitude: p.longitude
      }))))
      if (list && gauges) plan(ctx)
      else ctx.job('plan', 'station', () => plan(ctx))
    },
    view (ctx) {
      const station = ctx.state.station
      if (!station) return null
      const d = datum(ctx)
      const predicted = stationData(ctx.state, 'predicted', station.id)
      const extremes = stationData(ctx.state, 'extremes', station.id)
      const observed = stationData(ctx.state, 'observed', station.id)
      // highs and lows come above OD Malin
      const shift = d === 'ODM' ? 0 : predicted ? predicted.offset : null
      const gaugeNote = station.gauge && distance(station, station.gauge) > 0 ? `, measured at ${station.gauge.name}` : ''
      return {
        station: { id: station.id, name: station.name, latitude: station.latitude, longitude: station.longitude },
        datum: d === 'ODM' ? 'OD Malin' : 'LAT',
        extremes: extremes && shift !== null ? extremes.points.map(p => Object.assign({}, p, { value: p.value + shift })) : undefined,
        predicted: predicted ? predicted[d] : undefined,
        observed: observed ? observed[d] : undefined,
        attribution: `Marine Institute, Ireland (CC BY 4.0)${gaugeNote}`
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.readTable = readTable
