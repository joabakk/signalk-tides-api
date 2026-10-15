/*
 * FMI (Finnish Meteorological Institute) open data, WFS (no key): https://opendata.fmi.fi/wfs
 *
 *   fmi::forecast::sealevel::point::simple   sea level forecast for any point, hourly, 2 days:
 *                                            SeaLevel (cm, theoretical mean water level) and
 *                                            SeaLevelN2000 (cm, the Finnish height system N2000)
 *   fmi::observations::mareograph::simple    measured sea level at FMI's 14 tide gauges, hourly:
 *                                            watlev (mm, theoretical mean water level). Without a
 *                                            station id it answers for all gauges at once.
 *
 * The Baltic has hardly any tide, so there are no predicted highs and lows: the provider publishes
 * the forecast and the measured sea level. In N2000 the measurement is converted with the offset
 * between the forecast's two series at the boat (constant per place; 21.1 cm at Helsinki).
 * Data: FMI, CC BY 4.0.
 *
 * Requests: the forecast hourly or after a move of 5 km, and the gauges at the refresh interval
 * (default 20 min; the gauges report hourly).
 */

const createProvider = require('../lib/tide-provider')
const { http, buildUrl, noData, quiet, nearest, HOUR } = createProvider

const DEFAULT_API_URL = 'https://opendata.fmi.fi/wfs'
const MOVE_LIMIT = 5000 // m

// The simple feature format has positions but no names; these are FMI's tide gauges.
const GAUGES = [
  ['Kemi Ajos', 65.67337, 24.51526],
  ['Oulu Toppila', 65.04030, 25.41820],
  ['Raahe Lapaluoto', 64.66630, 24.40708],
  ['Pietarsaari Leppäluoto', 63.70857, 22.68958],
  ['Vaasa Vaskiluoto', 63.08150, 21.57118],
  ['Kaskinen Ådskär', 62.34395, 21.21483],
  ['Pori Mäntyluoto', 61.59438, 21.46343],
  ['Rauma Petäjäs', 61.13390, 21.44263],
  ['Turku Ruissalo', 60.42828, 22.10053],
  ['Föglö Degerby', 60.03188, 20.38482],
  ['Hanko', 59.82287, 22.97658],
  ['Helsinki Kaivopuisto', 60.15363, 24.95622],
  ['Porvoo Emäsalo', 60.20579, 25.62509],
  ['Hamina Pitäjänsaari', 60.56277, 27.17920]
]

// <BsWfs:BsWfsElement> blocks: position, time, parameter, value
function parseSimpleFeatures (xml) {
  const text = String(xml || '')
  const exception = /<ExceptionText>([\s\S]*?)<\/ExceptionText>/.exec(text)
  if (exception) throw new Error(exception[1].trim().slice(0, 200))
  if (!/<wfs:FeatureCollection\b/.test(text)) throw new Error('not an FMI feature collection')
  const out = []
  const re = /<BsWfs:BsWfsElement\b[\s\S]*?<\/BsWfs:BsWfsElement>/g
  let m
  while ((m = re.exec(text))) {
    const block = m[0]
    const pos = /<gml:pos>\s*([-\d.]+)\s+([-\d.]+)/.exec(block)
    const time = /<BsWfs:Time>([^<]*)</.exec(block)
    const name = /<BsWfs:ParameterName>([^<]*)</.exec(block)
    const value = /<BsWfs:ParameterValue>([^<]*)</.exec(block)
    if (!pos || !time || !name || !value) continue
    const v = Number(value[1].trim())
    const t = new Date(time[1].trim())
    if (!isFinite(v) || isNaN(t.getTime()) || /nan/i.test(value[1])) continue
    out.push({ latitude: Number(pos[1]), longitude: Number(pos[2]), time: t, parameter: name[1].trim(), value: v })
  }
  return out
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getText = deps.getText || http.getText

  function apiUrl (ctx) {
    return (ctx.options.fmiApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function datum (ctx) {
    return ctx.options.fmiDatum === 'N2000' ? 'N2000' : 'MW'
  }

  function iso (t) {
    return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }

  function query (ctx, storedQuery, params) {
    const url = buildUrl(apiUrl(ctx), Object.assign({
      service: 'WFS', version: '2.0.0', request: 'getFeature', storedquery_id: storedQuery
    }, params))
    ctx.debug(`GET ${url}`)
    return getText(url).then(parseSimpleFeatures, err => {
      // WFS errors come as an ExceptionReport with HTTP 400
      const m = /<ExceptionText>([\s\S]*?)<\/ExceptionText>/.exec(err.message)
      throw m ? new Error(m[1].trim()) : err
    })
  }

  function gaugeName (g) {
    const found = nearest(GAUGES.map(([name, latitude, longitude]) => ({ name, latitude, longitude })), g)
    return found && found.distance < 2000 ? found.item.name : `tide gauge ${g.latitude.toFixed(3)}, ${g.longitude.toFixed(3)}`
  }

  const spec = {
    optionKey: 'fmi',
    title: 'FMI (Finland, sea level forecast and measurements)',
    name: 'FMI',
    attribution: 'Finnish Meteorological Institute (CC BY 4.0); forecast and measured sea level, no tide predictions',
    refreshKey: 'fmiRefreshMinutes',
    defaultRefreshMinutes: 20,
    minRefreshMinutes: 10,
    maxObservationAgeMinutes: 150, // hourly values, published shortly after the hour
    forecast: false,
    properties: {
      fmiDatum: {
        type: 'string',
        title: 'FMI: reference level (zero) for heights',
        enum: ['MW', 'N2000'],
        enumNames: ['Theoretical mean water level (MW)', 'N2000 (Finnish height system)'],
        default: 'MW'
      },
      fmiRefreshMinutes: {
        type: 'number',
        title: 'FMI: minutes between measured sea level updates (minimum 10)',
        default: 20
      },
      fmiMaxDistanceKm: {
        type: 'number',
        title: 'FMI: use the nearest tide gauge within this distance (km)',
        default: 50
      },
      fmiApiUrl: {
        type: 'string',
        title: 'FMI: API address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const s = ctx.state
      const t = ctx.t
      const pos = ctx.position
      const f = s.forecast
      const moved = f && nearest([f.at], pos).distance > MOVE_LIMIT
      if (!f || moved || t - f.fetchedAt >= HOUR) {
        const at = { latitude: Math.round(pos.latitude * 100) / 100, longitude: Math.round(pos.longitude * 100) / 100 }
        ctx.job('forecast', 'sea level forecast', () => query(ctx, 'fmi::forecast::sealevel::point::simple', {
          latlon: `${at.latitude},${at.longitude}`, starttime: iso(t - HOUR), endtime: iso(t + 48 * HOUR)
        }).then(rows => {
          const series = name => rows.filter(r => r.parameter === name).map(r => ({ time: r.time, value: r.value / 100 }))
            .sort((a, b) => a.time - b.time)
          const mw = series('SeaLevel')
          const n2000 = series('SeaLevelN2000')
          if (mw.length === 0) throw noData('no sea level forecast for this position (FMI covers the Baltic Sea)')
          const offsets = n2000.map(p => {
            const same = mw.find(q => q.time.getTime() === p.time.getTime())
            return same ? p.value - same.value : null
          }).filter(v => v !== null)
          s.forecast = { at, fetchedAt: t, MW: mw, N2000: n2000, offset: offsets.length ? offsets[0] : null }
        }))
      }
      const observed = s.observed
      if (!observed || t - observed.fetchedAt >= ctx.refreshMs) {
        ctx.job('observed', 'measured sea level', () => query(ctx, 'fmi::observations::mareograph::simple', {
          parameters: 'watlev', starttime: iso(t - 3 * HOUR), endtime: iso(t)
        }).then(rows => {
          const gauges = []
          for (const r of rows.filter(r => r.parameter.toLowerCase() === 'watlev')) {
            let g = gauges.find(g => g.latitude === r.latitude && g.longitude === r.longitude)
            if (!g) gauges.push(g = { latitude: r.latitude, longitude: r.longitude, points: [] })
            g.points.push({ time: r.time, value: r.value / 1000 })
          }
          gauges.forEach(g => g.points.sort((a, b) => a.time - b.time))
          s.observed = { fetchedAt: t, gauges }
        }))
      }
    },
    view (ctx) {
      const s = ctx.state
      const d = datum(ctx)
      const f = s.forecast
      const maxKm = Number(ctx.options.fmiMaxDistanceKm)
      const maxDistance = (isFinite(maxKm) && maxKm > 0 ? maxKm : 50) * 1000
      const found = s.observed && nearest(s.observed.gauges, ctx.position)
      const gauge = found && found.distance <= maxDistance ? found.item : null
      let observed
      if (gauge && d === 'MW') observed = gauge.points
      else if (gauge && f && f.offset !== null) observed = gauge.points.map(p => ({ time: p.time, value: p.value + f.offset }))
      const forecast = f && f[d] && f[d].length ? f[d] : undefined
      if (!forecast && !observed) {
        if (s.observed && !gauge && !f) throw quiet(`no FMI tide gauge within ${maxDistance / 1000} km`)
        return null
      }
      const station = observed
        ? { id: `${gauge.latitude},${gauge.longitude}`, name: gaugeName(gauge), latitude: gauge.latitude, longitude: gauge.longitude }
        : { id: `${f.at.latitude},${f.at.longitude}`, name: 'forecast point', latitude: f.at.latitude, longitude: f.at.longitude }
      return { station, datum: d, forecast, observed }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.parseSimpleFeatures = parseSimpleFeatures
module.exports.GAUGES = GAUGES
