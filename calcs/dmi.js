/*
 * Tide provider for DMI, the Danish Meteorological Institute (Denmark, Greenland, Faroe Islands).
 *
 * Data: https://www.dmi.dk/friedata/dokumentation/apis/oceanographic-observation-and-tidewater-api
 * Licence: CC BY 4.0. Credit "Danish Meteorological Institute (DMI)". No API key.
 *
 * DMI publishes tide predictions per station (computed yearly, two years ahead) and measured
 * sea level from tide gauges every 10 minutes, as GeoJSON (OGC API Features):
 *   tidewaterstation  prediction stations, with their low astronomical tide (LAT) offset
 *   station           tide gauges; ids are similar but not identical to prediction stations
 *   tidewater         predictions: predictionType=minimum_maximum (highs and lows) or 10minutes
 *   observation       measurements: parameterId=sealev_dvr
 * Heights are in cm relative to DVR90, a land datum, so lows are often negative.
 *
 * Requests: the station lists once a month (kept in a file), highs and lows for 7 days and the
 * 10-minute prediction for 2 days only when they run out or the nearest station changes, and the
 * latest measurement at the refresh interval (default 10 min, DMI's update cycle).
 */

const fs = require('fs')
const path = require('path')
const superagent = require('superagent')
const moment = require('moment')
const geolib = require('geolib')
const {
  valueAt, latestObservation, nextExtremes, buildUrl, validPosition, USER_AGENT,
  MINUTE, HOUR, DAY, ERROR_BACKOFF, REQUEST_TIMEOUT
} = require('./kartverket')

const DEFAULT_API_URL = 'https://opendataapi.dmi.dk/v2/oceanObs/collections'
const ATTRIBUTION = 'Danish Meteorological Institute (DMI), CC BY 4.0'

const REPUBLISH_INTERVAL = MINUTE
const MIN_REFRESH_MINUTES = 10
const STATIONS_MAX_AGE = 30 * DAY
const GAUGE_MATCH_DISTANCE = 1000 // metres between a prediction station and its gauge
const MAX_OBSERVATION_AGE = HOUR
const PAGE_LIMIT = 10000

const META = [
  ['environment.tide.heightPredicted', 'Astronomical tide now, from DMI'],
  ['environment.tide.weatherEffect', 'Measured minus astronomical tide (effect of wind and air pressure), from DMI'],
  ['environment.tide.heightObserved', 'Latest measured water level at the nearest DMI tide gauge']
].map(([p, description]) => ({ path: p, value: { units: 'm', description } }))

module.exports = function (app, plugin, deps) {
  const fetchJson = (deps && deps.fetchJson) || defaultFetchJson
  const republishInterval = (deps && deps.republishInterval) || REPUBLISH_INTERVAL

  let stations      // { predictions: [...], gauges: [...], fetchedAt }
  let station       // nearest prediction station in use
  let extremes      // { stationId, points, fetchedAt }
  let curve         // { stationId, points, fetchedAt }
  let observed      // { stationId, point, fetchedAt }
  const failures = {}
  let running
  let timer
  let metaSent = false

  function config () {
    const tides = (plugin.properties && plugin.properties.tides) || {}
    const refresh = Number(tides.dmiRefreshMinutes) || MIN_REFRESH_MINUTES
    const maxKm = Number(tides.dmiMaxDistanceKm)
    return {
      apiUrl: (tides.dmiApiUrl || DEFAULT_API_URL).replace(/\/+$/, ''),
      datum: tides.dmiDatum === 'LAT' ? 'LAT' : 'DVR90',
      refreshMs: Math.max(refresh, MIN_REFRESH_MINUTES) * MINUTE,
      maxDistance: (isFinite(maxKm) && maxKm > 0 ? maxKm : 50) * 1000
    }
  }

  function reportError (what, err) {
    const message = `DMI ${what}: ${err && err.message ? err.message : err}`
    if (app.setPluginError) app.setPluginError(message)
    else if (app.setProviderError) app.setProviderError(message)
    app.error(message)
  }

  function currentTime () {
    const dt = app.getSelfPath('navigation.datetime')
    const value = dt && typeof dt === 'object' ? dt.value : dt
    const parsed = value ? new Date(value) : null
    return parsed && !isNaN(parsed.getTime()) ? parsed : new Date()
  }

  // Waits 5, 10, 20 ... minutes after failures, up to the refresh interval (at least 30 min).
  function due (kind, t) {
    return !failures[kind] || t >= failures[kind].retryAt
  }
  function failed (kind, what, err, cfg, t) {
    const f = failures[kind] || (failures[kind] = { count: 0 })
    f.count++
    const cap = Math.max(cfg.refreshMs, 30 * MINUTE)
    f.retryAt = t + Math.min(ERROR_BACKOFF * Math.pow(2, f.count - 1), cap)
    reportError(what, err)
  }
  function succeeded (kind) {
    delete failures[kind]
  }

  function items (cfg, collection, params) {
    const url = buildUrl(`${cfg.apiUrl}/${collection}/items`, Object.assign({ limit: PAGE_LIMIT }, params))
    app.debug(`dmi: GET ${url}`)
    return fetchJson(url).then(body => {
      if (!body || !Array.isArray(body.features)) {
        throw new Error(`unexpected response from ${collection}`)
      }
      return body.features.map(f => ({
        properties: f.properties || {},
        coordinates: (f.geometry && f.geometry.coordinates) || []
      }))
    })
  }

  // --- station lists, kept in a file for a month ---------------------------------

  function stationsFile () {
    const dir = typeof app.getDataDirPath === 'function' ? app.getDataDirPath() : app.config && app.config.configPath
    return dir ? path.join(dir, 'dmi-stations.json') : null
  }

  function loadStations (cfg, t) {
    if (stations && t - stations.fetchedAt < STATIONS_MAX_AGE) return Promise.resolve(stations)
    const file = stationsFile()
    if (!stations && file) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (saved && Array.isArray(saved.predictions) && Array.isArray(saved.gauges)) {
          stations = saved // also kept as a fallback when it is too old and DMI can't be reached
          if (t - saved.fetchedAt < STATIONS_MAX_AGE) return Promise.resolve(stations)
        }
      } catch (err) {
        // no file yet, or unreadable: fetch below
      }
    }
    if (!due('stations', t)) {
      return stations ? Promise.resolve(stations) : Promise.reject(new Error('station list not available yet'))
    }
    return items(cfg, 'tidewaterstation', {})
      .then(predictionFeatures => items(cfg, 'station', {}).then(gaugeFeatures => {
        const predictions = predictionFeatures.map(f => ({
          id: String(f.properties.stationId),
          name: String(f.properties.name),
          latitude: f.coordinates[1],
          longitude: f.coordinates[0],
          lowAstronomicalTide: Number(f.properties.lowAstronomicalTide) // cm below DVR90
        })).filter(s => isFinite(s.latitude) && isFinite(s.longitude))
        const gauges = gaugeFeatures
          .filter(f => f.properties.status === 'Active' && f.properties.validTo == null &&
            (f.properties.parameterId || []).includes('sealev_dvr'))
          .map(f => ({
            id: String(f.properties.stationId),
            name: String(f.properties.name),
            latitude: f.coordinates[1],
            longitude: f.coordinates[0]
          }))
        if (predictions.length === 0) throw new Error('no tide stations in response')
        stations = { predictions, gauges, fetchedAt: t }
        succeeded('stations')
        if (file) {
          fs.writeFile(file, JSON.stringify(stations), err => {
            if (err) app.debug(`dmi: could not save station list: ${err.message}`)
          })
        }
        return stations
      }))
      .catch(err => {
        failed('stations', 'station list', err, cfg, t)
        if (stations) return stations
        throw err
      })
  }

  function nearest (list, position) {
    let best = null
    let bestDistance = Infinity
    for (const s of list) {
      const d = geolib.getDistance(position, s)
      if (d < bestDistance) {
        best = s
        bestDistance = d
      }
    }
    return best ? { station: best, distance: bestDistance } : null
  }

  // Gauge measuring sealev_dvr: the same id if there is one, else the nearest within 1 km.
  function gaugeFor (s) {
    const same = stations.gauges.find(g => g.id === s.id)
    if (same) return same
    const near = nearest(stations.gauges, s)
    return near && near.distance <= GAUGE_MATCH_DISTANCE ? near.station : null
  }

  // --- fetching ---------------------------------------------------------------

  function interval (from, to) {
    const fmt = 'YYYY-MM-DDTHH:mm:ss[Z]'
    return `${moment.utc(from).format(fmt)}/${moment.utc(to).format(fmt)}`
  }

  function toPoint (p) {
    const value = parseFloat(p.value)
    const time = new Date(p.predictionTime || p.observed)
    if (!isFinite(value) || isNaN(time.getTime())) return null
    return { time, value: Math.round(value * 10) / 1000, flag: p.predictionType === 'maximum' ? 'high' : p.predictionType === 'minimum' ? 'low' : '' }
  }

  function refresh (position, now) {
    const cfg = config()
    const t = now.getTime()
    return loadStations(cfg, t).then(() => {
      const near = nearest(stations.predictions, position)
      if (!near || near.distance > cfg.maxDistance) {
        station = undefined
        throw Object.assign(new Error(`no DMI tide station within ${cfg.maxDistance / 1000} km`), { quiet: true })
      }
      station = near.station
      const sid = station.id
      const jobs = []

      const futureExtremes = extremes && extremes.stationId === sid
        ? extremes.points.filter(p => p.time > now) : []
      const extremesDue = futureExtremes.length === 0 ||
        futureExtremes[futureExtremes.length - 1].time.getTime() - t < DAY
      if (extremesDue && due('extremes', t)) {
        jobs.push(() => items(cfg, 'tidewater', {
          stationId: sid,
          predictionType: 'minimum_maximum',
          datetime: interval(t - HOUR, t + 7 * DAY)
        }).then(features => {
          const points = features.map(f => toPoint(f.properties)).filter(Boolean).sort((a, b) => a.time - b.time)
          if (points.length === 0) throw new Error(`no predictions for station ${sid}`)
          extremes = { stationId: sid, points, fetchedAt: t }
          succeeded('extremes')
        }).catch(err => failed('extremes', 'tide table', err, cfg, t)))
      }

      const curveEnd = curve && curve.stationId === sid && curve.points.length
        ? curve.points[curve.points.length - 1].time.getTime() : 0
      if (curveEnd - t < 6 * HOUR && due('curve', t)) {
        jobs.push(() => items(cfg, 'tidewater', {
          stationId: sid,
          predictionType: '10minutes',
          datetime: interval(t - HOUR, t + 2 * DAY)
        }).then(features => {
          // 10-minute predictions come back newest first
          const points = features.map(f => toPoint(f.properties)).filter(Boolean).sort((a, b) => a.time - b.time)
          if (points.length === 0) throw new Error(`no 10-minute predictions for station ${sid}`)
          curve = { stationId: sid, points, fetchedAt: t }
          succeeded('curve')
        }).catch(err => failed('curve', 'prediction', err, cfg, t)))
      }

      const gauge = gaugeFor(station)
      if (!gauge) {
        observed = undefined
      } else if ((!observed || observed.stationId !== gauge.id || t - observed.fetchedAt >= cfg.refreshMs) && due('observed', t)) {
        jobs.push(() => items(cfg, 'observation', {
          stationId: gauge.id,
          parameterId: 'sealev_dvr',
          period: 'latest-hour'
        }).then(features => {
          const points = features.map(f => toPoint(f.properties)).filter(Boolean).sort((a, b) => a.time - b.time)
          observed = { stationId: gauge.id, name: gauge.name, point: points[points.length - 1] || null, fetchedAt: t }
          succeeded('observed')
        }).catch(err => failed('observed', 'measurement', err, cfg, t)))
      }

      // One request at a time.
      return jobs.reduce((p, job) => p.then(job), Promise.resolve())
    })
  }

  // DVR90 heights, or heights above the station's lowest astronomical tide.
  function offset (cfg) {
    return cfg.datum === 'LAT' && station && isFinite(station.lowAstronomicalTide) ? -station.lowAstronomicalTide / 100 : 0
  }
  function adjust (value, cfg) {
    return value === null || value === undefined ? value : Math.round((value + offset(cfg)) * 1000) / 1000
  }

  function deltas (now) {
    const cfg = config()
    const values = []
    const push = (p, value) => {
      if (value !== null && value !== undefined) values.push({ path: p, value })
    }
    if (!station) return values
    const sid = station.id

    if (extremes && extremes.stationId === sid) {
      const { high, low } = nextExtremes(extremes.points, now)
      if (high) {
        push('environment.tide.heightHigh', adjust(high.value, cfg))
        push('environment.tide.timeHigh', high.time.toISOString())
      }
      if (low) {
        push('environment.tide.heightLow', adjust(low.value, cfg))
        push('environment.tide.timeLow', low.time.toISOString())
      }
    }

    const predicted = curve && curve.stationId === sid ? valueAt(curve.points, now) : null
    const obs = observed && observed.point ? latestObservation([observed.point], now, MAX_OBSERVATION_AGE) : null
    push('environment.tide.heightPredicted', adjust(predicted, cfg))
    if (obs) {
      push('environment.tide.heightObserved', adjust(obs.value, cfg))
      const predictedThen = curve && curve.stationId === sid ? valueAt(curve.points, obs.time) : null
      if (predictedThen !== null) push('environment.tide.weatherEffect', Math.round((obs.value - predictedThen) * 1000) / 1000)
    }
    let source
    if (obs) {
      source = 'measurement'
      push('environment.tide.heightNow', adjust(obs.value, cfg))
    } else if (predicted !== null) {
      source = 'prediction'
      push('environment.tide.heightNow', adjust(predicted, cfg))
    }

    if (values.length && !metaSent) {
      metaSent = true
      app.handleMessage(plugin.id, { context: 'vessels.' + app.selfId, updates: [{ meta: META }] })
    }
    const setStatus = app.setPluginStatus || app.setProviderStatus
    if (values.length && setStatus) {
      setStatus.call(app, `DMI ${station.name} (${cfg.datum})` +
        (source ? `, height now from ${source}` : '') + `. Data: ${ATTRIBUTION}`)
    }
    return values
  }

  function run (position) {
    if (!validPosition(position)) {
      app.debug('dmi: no valid position, skipping')
      return Promise.resolve(undefined)
    }
    if (running) return running
    const now = currentTime()
    running = refresh(position, now)
      .then(() => deltas(now))
      .catch(err => {
        if (err && err.quiet) app.debug(`dmi: ${err.message}`)
        else reportError('update', err)
        return []
      })
      .then(values => {
        running = undefined
        return values && values.length ? values : undefined
      })
    return running
  }

  function republish () {
    const pos = app.getSelfPath('navigation.position')
    run(pos && pos.value !== undefined ? pos.value : pos).then(values => {
      if (values) {
        app.handleMessage(plugin.id, {
          context: 'vessels.' + app.selfId,
          updates: [{ timestamp: new Date().toISOString(), $source: `${plugin.id}.dmi`, values }]
        })
      }
    })
  }

  // Coming high and low tides in the shape of the 'tides' resource of signalk-tides.
  function tideForecast () {
    const pos = app.getSelfPath('navigation.position')
    const position = pos && pos.value !== undefined ? pos.value : pos
    if (!validPosition(position)) return Promise.reject(new Error('No position'))
    return run(position).then(() => {
      const cfg = config()
      if (!station) throw new Error(`No DMI tide station within ${cfg.maxDistance / 1000} km`)
      if (!extremes || extremes.stationId !== station.id) throw new Error('No DMI tide table yet')
      const now = currentTime()
      return {
        datum: cfg.datum,
        units: 'meters',
        station: { id: `dmi/${station.id}`, name: station.name, latitude: station.latitude, longitude: station.longitude },
        extremes: extremes.points
          .filter(p => p.time > now)
          .map(p => {
            const high = p.flag === 'high'
            return { time: p.time.toISOString(), level: adjust(p.value, cfg), high, low: !high, label: high ? 'High' : 'Low' }
          })
      }
    })
  }

  return {
    group: 'tides',
    optionKey: 'dmi',
    title: 'DMI (Denmark, Greenland, Faroe Islands)',
    tideForecast,
    derivedFrom: ['navigation.position'],
    properties: {
      dmiDatum: {
        type: 'string',
        title: 'DMI: reference level (zero) for heights',
        enum: ['DVR90', 'LAT'],
        enumNames: ['DVR90 (Danish height datum, close to mean sea level)', 'Lowest astronomical tide (LAT) at the station'],
        default: 'DVR90'
      },
      dmiRefreshMinutes: {
        type: 'number',
        title: 'DMI: minutes between measured water level updates (minimum 10)',
        default: 10
      },
      dmiMaxDistanceKm: {
        type: 'number',
        title: 'DMI: use the nearest tide station within this distance (km)',
        default: 50
      },
      dmiApiUrl: {
        type: 'string',
        title: 'DMI: API address',
        default: DEFAULT_API_URL
      }
    },
    debounceDelay: 60 * 1000,
    calculator: function (position) {
      if (!timer) timer = setInterval(republish, republishInterval)
      try {
        return run(position)
      } catch (err) {
        reportError('update', err)
        return Promise.resolve(undefined)
      }
    },
    stop: function () {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}

function defaultFetchJson (url) {
  return superagent
    .get(url)
    .set('User-Agent', USER_AGENT)
    .set('Accept', 'application/geo+json, application/json')
    .timeout(REQUEST_TIMEOUT)
    .buffer(true)
    .parse((res, done) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => done(null, text))
    })
    .then(res => {
      try {
        return JSON.parse(res.body)
      } catch (err) {
        throw new Error('bad JSON: ' + String(res.body).slice(0, 120))
      }
    })
}

module.exports.defaultFetchJson = defaultFetchJson
module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.ATTRIBUTION = ATTRIBUTION
