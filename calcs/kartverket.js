/*
 * Tide provider for Kartverket (Norwegian Mapping Authority, Hydrographic Service).
 *
 * Data: https://vannstand.kartverket.no/tideapi_en.html
 * Licence: CC BY 4.0. Credit "Kartverket, Norwegian Mapping Authority, Hydrographic Service".
 *
 * Two requests to the same endpoint (tide_request=locationdata):
 *   datatype=tab  high and low tide table, refetched when the next tide event has passed
 *   datatype=all  hourly prediction, weather effect and forecast (and observation near a
 *                 station), refetched every refresh interval (default 30 min)
 * Between fetches the cached series are re-published once a minute so that
 * environment.tide.heightNow keeps moving without extra requests.
 */

const superagent = require('superagent')
const moment = require('moment')
const geolib = require('geolib')
const pkg = require('../package.json')

const DEFAULT_API_URL = 'https://vannstand.kartverket.no/tideapi.php'
const USER_AGENT = `signalk-tides-api/${pkg.version} (+https://github.com/joabakk/signalk-tides-api)`
const ATTRIBUTION = 'Kartverket, Norwegian Mapping Authority, Hydrographic Service (CC BY 4.0)'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const REPUBLISH_INTERVAL = MINUTE
const MIN_REFRESH_MINUTES = 10
const ERROR_BACKOFF = 5 * MINUTE // doubled after each failure, up to the refresh interval (at least 30 min)
const REFETCH_DISTANCE = 5000 // metres moved before the location data is fetched again
const MAX_OBSERVATION_AGE = 3 * HOUR
const REQUEST_TIMEOUT = { response: 20 * 1000, deadline: 60 * 1000 }

// Units and descriptions for the paths that are not in the Signal K specification.
const META = [
  ['environment.tide.heightPredicted', 'Astronomical tide now, from Kartverket'],
  ['environment.tide.heightForecast', 'Forecast water level now including wind and air pressure, from Kartverket'],
  ['environment.tide.weatherEffect', 'Effect of wind and air pressure on the water level (forecast minus astronomical tide), from Kartverket'],
  ['environment.tide.heightObserved', 'Latest observed water level, from Kartverket']
].map(([path, description]) => ({ path, value: { units: 'm', description } }))

module.exports = function (app, plugin, deps) {
  const fetchText = (deps && deps.fetchText) || defaultFetchText
  const republishInterval = (deps && deps.republishInterval) || REPUBLISH_INTERVAL

  let tab        // { points, position, refcode, fetchedAt, nextEventTime }
  let levels     // { series, position, refcode, fetchedAt }
  let observed   // { series, position, refcode, fetchedAt } from the optional station position
  const failures = { tab: { count: 0, retryAt: 0 }, levels: { count: 0, retryAt: 0 }, observed: { count: 0, retryAt: 0 } }
  let running
  let timer
  let metaSent = false

  function config () {
    const tides = (plugin.properties && plugin.properties.tides) || {}
    const refresh = Number(tides.kartverketRefreshMinutes) || 30
    const stationLat = parseFloat(tides.kartverketStationLatitude)
    const stationLon = parseFloat(tides.kartverketStationLongitude)
    return {
      apiUrl: tides.kartverketApiUrl || DEFAULT_API_URL,
      refcode: tides.kartverketRefcode || 'CD',
      refreshMs: Math.max(refresh, MIN_REFRESH_MINUTES) * MINUTE,
      station: isFinite(stationLat) && isFinite(stationLon)
        ? { latitude: stationLat, longitude: stationLon }
        : undefined
    }
  }

  function reportError (what, err) {
    const message = `Kartverket ${what}: ${err && err.message ? err.message : err}`
    // setPluginError/Status replace setProviderError/Status in newer servers
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

  // A position without data won't get any soon: wait a full interval. Other errors back off
  // 5, 10, 20 ... minutes so an unreachable service isn't polled every few minutes.
  function failed (kind, what, err, cfg, t) {
    const f = failures[kind]
    f.count++
    const cap = Math.max(cfg.refreshMs, 30 * MINUTE)
    const wait = err && err.noData ? cap : Math.min(ERROR_BACKOFF * Math.pow(2, f.count - 1), cap)
    f.retryAt = t + wait
    reportError(what, err)
  }

  function succeeded (kind) {
    failures[kind].count = 0
    failures[kind].retryAt = 0
  }

  function noData (info) {
    const err = new Error(info)
    err.noData = true
    return err
  }

  function moved (cache, position) {
    return geolib.getDistance(cache.position, position) > REFETCH_DISTANCE
  }

  function request (cfg, position, datatype, now, hours) {
    const url = buildUrl(cfg.apiUrl, {
      tide_request: 'locationdata',
      lat: position.latitude.toFixed(4),
      lon: position.longitude.toFixed(4),
      fromtime: moment.utc(now).subtract(1, 'hour').startOf('hour').format('YYYY-MM-DDTHH:mm'),
      totime: moment.utc(now).add(hours || 30, 'hours').format('YYYY-MM-DDTHH:mm'),
      datatype: datatype,
      refcode: cfg.refcode,
      lang: 'en',
      interval: 60,
      dst: 0,
      tzone: 0
    })
    app.debug(`kartverket: GET ${url}`)
    return fetchText(url).then(parseTideXml)
  }

  // Fetches whatever is due. Failures are reported and leave the old cache in place.
  function refresh (position, now) {
    const cfg = config()
    const t = now.getTime()
    const jobs = []

    // Like the NOAA provider: ask again once the next high or low has passed.
    const tabDue = !tab || moved(tab, position) || t >= tab.nextEventTime ||
      tab.refcode !== cfg.refcode
    if (tabDue && t >= failures.tab.retryAt) {
      // 7 days of highs and lows for the tides resource; it is a short list.
      jobs.push(() => request(cfg, position, 'tab', now, 7 * 24).then(result => {
        if (result.nodata) throw noData(result.nodata)
        const points = extremesFrom(result)
        const ext = nextExtremes(points, now)
        const next = [ext.high, ext.low].filter(Boolean).map(p => p.time.getTime())
        if (points.length === 0) {
          app.debug('kartverket: no high/low flags in tide table, deriving them from the prediction')
        }
        tab = {
          points,
          position,
          location: result.location,
          refcode: cfg.refcode,
          fetchedAt: t,
          nextEventTime: next.length ? Math.min.apply(null, next) : t + 6 * HOUR
        }
        succeeded('tab')
      }).catch(err => failed('tab', 'tide table', err, cfg, t)))
    }

    const levelsDue = !levels || moved(levels, position) || t - levels.fetchedAt >= cfg.refreshMs ||
      (levels.refcode !== cfg.refcode)
    if (levelsDue && t >= failures.levels.retryAt) {
      jobs.push(() => request(cfg, position, 'all', now).then(result => {
        if (result.nodata) throw noData(result.nodata)
        levels = { series: result.series, position, location: result.location, refcode: cfg.refcode, fetchedAt: t }
        succeeded('levels')
      }).catch(err => failed('levels', 'water level', err, cfg, t)))
    }

    if (cfg.station) {
      const obsDue = !observed || t - observed.fetchedAt >= cfg.refreshMs ||
        geolib.getDistance(observed.position, cfg.station) > 0 || observed.refcode !== cfg.refcode
      if (obsDue && t >= failures.observed.retryAt) {
        jobs.push(() => request(cfg, cfg.station, 'obs', now).then(result => {
          if (result.nodata) throw noData(result.nodata)
          observed = { series: result.series, position: cfg.station, refcode: cfg.refcode, fetchedAt: t }
          succeeded('observed')
        }).catch(err => failed('observed', 'observation', err, cfg, t)))
      }
    } else {
      observed = undefined
    }

    // One request at a time is enough; the API asks for minimal load.
    return jobs.reduce((p, job) => p.then(job), Promise.resolve())
  }

  function deltas (now) {
    const values = []
    const push = (path, value) => {
      if (value !== null && value !== undefined) values.push({ path, value })
    }

    let points = tab && tab.points.length ? tab.points : null
    if (!points && levels) points = extremesInSeries(levels.series.prediction)
    if (points) {
      const { high, low } = nextExtremes(points, now)
      if (high) {
        push('environment.tide.heightHigh', high.value)
        push('environment.tide.timeHigh', high.time.toISOString())
      }
      if (low) {
        push('environment.tide.heightLow', low.value)
        push('environment.tide.timeLow', low.time.toISOString())
      }
    }

    let source
    if (levels) {
      const s = levels.series
      const predicted = valueAt(s.prediction, now)
      const forecast = valueAt(s.forecast, now)
      push('environment.tide.heightPredicted', predicted)
      push('environment.tide.heightForecast', forecast)
      // The weather effect series stops at the latest observation, so between hours use
      // the latest value; without the series, forecast minus prediction.
      let weather = valueAt(s.weathereffect, now)
      if (weather === null) {
        const latest = latestObservation(s.weathereffect, now)
        if (latest) weather = latest.value
        else if (forecast !== null && predicted !== null) weather = round(forecast - predicted)
      }
      push('environment.tide.weatherEffect', weather)
      const obs = latestObservation(s.observation, now)
      const stationObs = observed ? latestObservation(observed.series.observation, now) : null
      const best = stationObs || obs
      if (best) push('environment.tide.heightObserved', best.value)

      if (obs) {
        source = 'observation'
        push('environment.tide.heightNow', obs.value)
      } else if (forecast !== null) {
        source = 'forecast'
        push('environment.tide.heightNow', forecast)
      } else if (predicted !== null) {
        source = 'prediction'
        push('environment.tide.heightNow', predicted)
      }
    } else if (observed) {
      const stationObs = latestObservation(observed.series.observation, now)
      if (stationObs) push('environment.tide.heightObserved', stationObs.value)
    }

    if (values.length && !metaSent) {
      metaSent = true
      app.handleMessage(plugin.id, {
        context: 'vessels.' + app.selfId,
        updates: [{ meta: META }]
      })
    }

    const setStatus = app.setPluginStatus || app.setProviderStatus
    if (values.length && setStatus) {
      setStatus.call(app, `Kartverket ${config().refcode}` +
        (source ? `, height now from ${source}` : '') + `. Data: ${ATTRIBUTION}`)
    }
    return values
  }

  function run (position) {
    if (!validPosition(position)) {
      app.debug('kartverket: no valid position, skipping')
      return Promise.resolve(undefined)
    }
    if (running) return running
    const now = currentTime()
    running = refresh(position, now)
      .then(() => {
        const values = deltas(now)
        return values.length ? values : undefined
      })
      .catch(err => {
        reportError('update', err)
        return undefined
      })
      .then(result => {
        running = undefined
        return result
      })
    return running
  }

  function republish () {
    const pos = app.getSelfPath('navigation.position')
    run(pos && pos.value !== undefined ? pos.value : pos).then(values => {
      if (values) {
        app.handleMessage(plugin.id, {
          context: 'vessels.' + app.selfId,
          updates: [{ timestamp: new Date().toISOString(), values }]
        })
      }
    })
  }

  // Coming high and low tides in the shape of the 'tides' resource of signalk-tides.
  // Uses the cached tide table, fetching only when the provider would anyway.
  function tideForecast () {
    const pos = app.getSelfPath('navigation.position')
    const position = pos && pos.value !== undefined ? pos.value : pos
    if (!validPosition(position)) return Promise.reject(new Error('No position'))
    return run(position).then(() => {
      let points = tab && tab.points.length ? tab.points : null
      if (!points && levels) points = extremesInSeries(levels.series.prediction)
      if (!points) throw new Error('No Kartverket tide table yet')
      const source = tab || levels
      const loc = source.location || {}
      const latitude = parseFloat(loc.latitude)
      const longitude = parseFloat(loc.longitude)
      const now = currentTime()
      return {
        datum: source.refcode,
        units: 'meters',
        station: {
          id: 'kartverket/' + (loc.code || `${source.position.latitude.toFixed(4)},${source.position.longitude.toFixed(4)}`),
          name: loc.name || 'Kartverket',
          latitude: isFinite(latitude) ? latitude : source.position.latitude,
          longitude: isFinite(longitude) ? longitude : source.position.longitude
        },
        extremes: points
          .filter(p => p.time > now)
          .map(p => {
            const high = p.flag.startsWith('h')
            return { time: p.time.toISOString(), level: p.value, high, low: !high, label: high ? 'High' : 'Low' }
          })
      }
    })
  }

  return {
    group: 'tides',
    optionKey: 'kartverket',
    tideForecast,
    title: 'Kartverket (Norway)',
    derivedFrom: ['navigation.position'],
    properties: {
      kartverketRefcode: {
        type: 'string',
        title: 'Kartverket: reference level (zero) for heights',
        enum: ['CD', 'MSL', 'NN2000'],
        enumNames: ['Chart datum (CD)', 'Mean sea level (MSL)', 'Norwegian height datum (NN2000)'],
        default: 'CD'
      },
      kartverketRefreshMinutes: {
        type: 'number',
        title: 'Kartverket: minutes between water level updates (minimum 10)',
        default: 30
      },
      kartverketStationLatitude: {
        type: 'number',
        title: 'Kartverket: latitude of a tide gauge station for observed water level (optional)'
      },
      kartverketStationLongitude: {
        type: 'number',
        title: 'Kartverket: longitude of that tide gauge station (optional)'
      },
      kartverketApiUrl: {
        type: 'string',
        title: 'Kartverket: API address',
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

// ---------------------------------------------------------------------------
// Pure helpers, exported for tests.

function defaultFetchText (url) {
  return superagent
    .get(url)
    .set('User-Agent', USER_AGENT)
    .set('Accept', 'application/xml, text/xml')
    .timeout(REQUEST_TIMEOUT)
    .buffer(true)
    .parse((res, done) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => done(null, text))
    })
    .then(res => res.body)
}

function buildUrl (base, params) {
  const url = new URL(base)
  Object.keys(params).forEach(k => url.searchParams.set(k, String(params[k])))
  return url.toString()
}

function decodeEntities (s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function parseAttributes (s) {
  const attrs = {}
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(s || ''))) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4])
  }
  return attrs
}

// Times come back with an offset; without one they are UTC because we ask for tzone=0.
function parseTime (s) {
  if (!s) return null
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s)
  const d = new Date(hasZone ? s : s + 'Z')
  return isNaN(d.getTime()) ? null : d
}

function seriesName (type) {
  const t = (type || '').toLowerCase()
  if (t.startsWith('obs')) return 'observation'
  if (t.startsWith('pre')) return 'prediction'
  if (t.startsWith('fore')) return 'forecast'
  if (t.startsWith('weather')) return 'weathereffect'
  return t || 'unknown'
}

/**
 * Parses a tideapi.php XML response.
 * Returns { location, reflevelcode, nodata, series: { prediction|observation|forecast|weathereffect: [points] } }
 * where each point is { time: Date, value: metres, flag }. Values arrive in cm.
 * Throws on an error response or something that isn't tide XML.
 */
function parseTideXml (xml) {
  if (typeof xml !== 'string') throw new Error('empty response')
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  if (!/<tide[\s>]/.test(body)) {
    throw new Error('unexpected response: ' + body.trim().slice(0, 120))
  }
  const error = /<error\b([^>]*?)(?:\/>|>([\s\S]*?)<\/error>)/.exec(body)
  if (error) {
    const attrs = parseAttributes(error[1])
    throw new Error('API error: ' + (decodeEntities((error[2] || '').trim()) || attrs.info || attrs.message || 'unknown'))
  }

  const result = { series: {} }
  const location = /<location\b([^>]*?)\/?>/.exec(body)
  if (location) result.location = parseAttributes(location[1])
  const ref = /<reflevelcode>([\s\S]*?)<\/reflevelcode>/.exec(body)
  if (ref) result.reflevelcode = decodeEntities(ref[1].trim())
  const nodata = /<nodata\b([^>]*?)\/?>/.exec(body)
  if (nodata) result.nodata = parseAttributes(nodata[1]).info || 'no data for this position'

  const dataRe = /<data\b([^>]*?)(?:\/>|>([\s\S]*?)<\/data>)/g
  let d
  while ((d = dataRe.exec(body))) {
    const attrs = parseAttributes(d[1])
    const name = seriesName(attrs.type)
    const unit = (attrs.unit || 'cm').toLowerCase()
    const scale = unit === 'm' ? 1 : unit === 'mm' ? 0.001 : 0.01
    const points = result.series[name] || (result.series[name] = [])
    const wlRe = /<waterlevel\b([^>]*?)\/?>/g
    let w
    while ((w = wlRe.exec(d[2] || ''))) {
      const a = parseAttributes(w[1])
      const value = parseFloat(a.value)
      const time = parseTime(a.time)
      if (!isFinite(value) || !time) continue
      points.push({ time, value: round(value * scale), flag: (a.flag || '').toLowerCase() })
    }
    points.sort((a, b) => a.time - b.time)
  }
  return result
}

function round (v) {
  return Math.round(v * 1000) / 1000
}

// High and low points from a tide table response, whatever series they are in.
function extremesFrom (result) {
  const all = []
  Object.keys(result.series).forEach(k => {
    result.series[k].forEach(p => {
      if (p.flag.startsWith('h') || p.flag.startsWith('l')) all.push(p)
    })
  })
  return all.sort((a, b) => a.time - b.time)
}

// Fallback when the tide table has no high/low flags: turning points of the hourly
// prediction, refined with a parabola through the three points around each one.
function extremesInSeries (series) {
  const out = []
  if (!series) return out
  for (let i = 1; i < series.length - 1; i++) {
    const a = series[i - 1]
    const b = series[i]
    const c = series[i + 1]
    const isHigh = b.value > a.value && b.value >= c.value
    const isLow = b.value < a.value && b.value <= c.value
    if (!isHigh && !isLow) continue
    const step = (c.time.getTime() - a.time.getTime()) / 2
    const denom = a.value - 2 * b.value + c.value
    const offset = denom === 0 ? 0 : 0.5 * (a.value - c.value) / denom // in steps, between -0.5 and 0.5
    const value = b.value - 0.25 * (a.value - c.value) * offset
    out.push({
      time: new Date(Math.round((b.time.getTime() + offset * step) / MINUTE) * MINUTE),
      value: round(value),
      flag: isHigh ? 'high' : 'low'
    })
  }
  return out
}

function nextExtremes (points, now) {
  const t = now.getTime()
  let high
  let low
  for (const p of points || []) {
    if (p.time.getTime() <= t) continue
    if (!high && p.flag.startsWith('h')) high = p
    if (!low && p.flag.startsWith('l')) low = p
    if (high && low) break
  }
  return { high, low }
}

// Linear interpolation inside the series, null outside it.
function valueAt (series, now) {
  if (!series || series.length === 0) return null
  const t = now.getTime()
  for (let i = 0; i < series.length; i++) {
    const b = series[i]
    const tb = b.time.getTime()
    if (tb === t) return b.value
    if (tb > t) {
      if (i === 0) return null
      const a = series[i - 1]
      const ta = a.time.getTime()
      return round(a.value + (b.value - a.value) * (t - ta) / (tb - ta))
    }
  }
  return null
}

function latestObservation (series, now, maxAge) {
  const t = now.getTime()
  const limit = maxAge || MAX_OBSERVATION_AGE
  let latest = null
  for (const p of series || []) {
    const tp = p.time.getTime()
    if (tp <= t && t - tp <= limit) latest = p
  }
  return latest
}

function validPosition (p) {
  return p && typeof p.latitude === 'number' && typeof p.longitude === 'number' &&
    isFinite(p.latitude) && isFinite(p.longitude)
}

module.exports.parseTideXml = parseTideXml
module.exports.nextExtremes = nextExtremes
module.exports.extremesFrom = extremesFrom
module.exports.extremesInSeries = extremesInSeries
module.exports.valueAt = valueAt
module.exports.latestObservation = latestObservation
module.exports.buildUrl = buildUrl
module.exports.defaultFetchText = defaultFetchText
module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.USER_AGENT = USER_AGENT
module.exports.ATTRIBUTION = ATTRIBUTION
