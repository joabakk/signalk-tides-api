/*
 * Shared plumbing for tide providers. A provider describes how to fetch its data and how to read
 * it into one common shape; this module does the rest, the same way for every provider:
 *
 *   - one request at a time, waiting 5, 10, 20 ... minutes after failures (up to the refresh
 *     interval, at least 30 min), a full interval when the source has no data for the position
 *   - publishing environment.tide.* (next high and low, height now, predicted, forecast, observed
 *     and weather effect) and re-publishing from the cache every minute without requests
 *   - units and descriptions for the paths outside the Signal K specification, sent once
 *   - the plugin status, with the data source credited
 *   - the 'tides' resource (tideForecast), in the shape of the signalk-tides plugin
 *
 * spec = {
 *   optionKey, title, name, attribution,
 *   properties,                       // the provider's own options (schema)
 *   refreshKey, defaultRefreshMinutes, minRefreshMinutes,
 *   maxObservationAgeMinutes,         // older measurements are not used (default 180)
 *   update (ctx),                     // queue the requests that are due with ctx.job()
 *   view (ctx)                        // the cached data as { station, datum, extremes, predicted,
 * }                                   //   forecast, observed, weatherEffect, attribution }
 *                                     //   (heights in metres; attribution overrides spec's)
 *
 * Points are { time: Date, value: metres } and extremes also have flag 'high' or 'low'.
 * This file lives outside calcs/ because index.js loads every file there as a provider.
 */

const superagent = require('superagent')
const geolib = require('geolib')
const { valueAt, latestObservation, nextExtremes, extremesInSeries, buildUrl, USER_AGENT } = require('../calcs/kartverket')

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const ERROR_BACKOFF = 5 * MINUTE
const REPUBLISH_INTERVAL = MINUTE
const REQUEST_TIMEOUT = { response: 20 * 1000, deadline: 60 * 1000 }

const PATH_DESCRIPTIONS = {
  'environment.tide.heightPredicted': 'Astronomical tide now',
  'environment.tide.heightForecast': 'Forecast water level now, including wind and air pressure',
  'environment.tide.weatherEffect': 'Effect of wind and air pressure on the water level',
  'environment.tide.heightObserved': 'Latest measured water level'
}

function createProvider (app, plugin, spec, deps) {
  deps = deps || {}
  const republishInterval = deps.republishInterval || REPUBLISH_INTERVAL
  const state = {}
  const failures = {}
  let running
  let timer
  let metaSent = false
  let lastView

  function options () {
    return (plugin.properties && plugin.properties.tides) || {}
  }

  function refreshMs () {
    const min = spec.minRefreshMinutes || 10
    const value = Number(options()[spec.refreshKey]) || spec.defaultRefreshMinutes || 30
    return Math.max(value, min) * MINUTE
  }

  function reportError (what, err) {
    const message = `${spec.name} ${what}: ${err && err.message ? err.message : err}`
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

  function selfPosition () {
    const pos = app.getSelfPath('navigation.position')
    return pos && pos.value !== undefined ? pos.value : pos
  }

  function context (position, now) {
    const t = now.getTime()
    const jobs = []
    const ctx = {
      app,
      position,
      now,
      t,
      options: options(),
      refreshMs: refreshMs(),
      state,
      debug: msg => app.debug(`${spec.optionKey}: ${msg}`),
      due: kind => !failures[kind] || t >= failures[kind].retryAt,
      // Queues a request; failures are reported and delay the next try of that kind.
      job: (kind, what, fn) => {
        if (!ctx.due(kind)) return
        jobs.push(() => Promise.resolve().then(fn).then(() => {
          delete failures[kind]
        }, err => {
          const f = failures[kind] || (failures[kind] = { count: 0 })
          f.count++
          const cap = Math.max(ctx.refreshMs, 30 * MINUTE)
          f.retryAt = t + (err && err.noData ? cap : Math.min(ERROR_BACKOFF * Math.pow(2, f.count - 1), cap))
          if (err && err.quiet) ctx.debug(err.message)
          else reportError(what, err)
        }))
      }
    }
    // One at a time; a job may queue more (e.g. data requests once the station list is in).
    ctx.run = () => {
      const next = () => jobs.length ? jobs.shift()().then(next) : Promise.resolve()
      return next()
    }
    return ctx
  }

  function deltas (view, now) {
    const values = []
    const push = (path, value) => {
      if (value !== null && value !== undefined && isFinite(value)) values.push({ path, value: round(value) })
    }
    const pushTime = (path, time) => { if (time) values.push({ path, value: time.toISOString() }) }
    if (!view) return values

    let extremes = view.extremes && view.extremes.length ? view.extremes : null
    if (!extremes && view.predicted) extremes = extremesInSeries(view.predicted)
    if (extremes) {
      const { high, low } = nextExtremes(extremes, now)
      if (high) {
        push('environment.tide.heightHigh', high.value)
        pushTime('environment.tide.timeHigh', high.time)
      }
      if (low) {
        push('environment.tide.heightLow', low.value)
        pushTime('environment.tide.timeLow', low.time)
      }
    }

    const predicted = valueAt(view.predicted, now)
    const forecast = valueAt(view.forecast, now)
    const maxAge = (spec.maxObservationAgeMinutes || 180) * MINUTE
    const observed = latestObservation(view.observed, now, maxAge)
    push('environment.tide.heightPredicted', predicted)
    push('environment.tide.heightForecast', forecast)
    if (observed) push('environment.tide.heightObserved', observed.value)

    let weather = valueAt(view.weatherEffect, now)
    if (weather === null) {
      const latest = latestObservation(view.weatherEffect, now, maxAge)
      if (latest) weather = latest.value
    }
    if (weather === null && observed) {
      const predictedThen = valueAt(view.predicted, observed.time)
      if (predictedThen !== null) weather = observed.value - predictedThen
    }
    if (weather === null && forecast !== null && predicted !== null) weather = forecast - predicted
    push('environment.tide.weatherEffect', weather)

    let source
    if (observed) {
      source = 'measurement'
      push('environment.tide.heightNow', observed.value)
    } else if (forecast !== null) {
      source = 'forecast'
      push('environment.tide.heightNow', forecast)
    } else if (predicted !== null) {
      source = 'prediction'
      push('environment.tide.heightNow', predicted)
    }

    if (values.length && !metaSent) {
      metaSent = true
      app.handleMessage(plugin.id, {
        context: 'vessels.' + app.selfId,
        updates: [{
          meta: Object.keys(PATH_DESCRIPTIONS).map(path => ({
            path,
            value: { units: 'm', description: `${PATH_DESCRIPTIONS[path]}, from ${spec.name}` }
          }))
        }]
      })
    }
    const setStatus = app.setPluginStatus || app.setProviderStatus
    if (values.length && setStatus) {
      const where = view.station && view.station.name ? ` ${view.station.name}` : ''
      setStatus.call(app, `${spec.name}${where}${view.datum ? ` (${view.datum})` : ''}` +
        (source ? `, height now from ${source}` : '') + `. Data: ${view.attribution || spec.attribution}`)
    }
    return values
  }

  function run (position) {
    if (!validPosition(position)) {
      app.debug(`${spec.optionKey}: no valid position, skipping`)
      return Promise.resolve(undefined)
    }
    if (running) return running
    const now = currentTime()
    const ctx = context(position, now)
    running = Promise.resolve()
      .then(() => spec.update(ctx))
      .then(() => ctx.run())
      .then(() => {
        lastView = spec.view(ctx)
        return deltas(lastView, now)
      })
      .catch(err => {
        if (err && err.quiet) app.debug(`${spec.optionKey}: ${err.message}`)
        else reportError('update', err)
        lastView = undefined
        return []
      })
      .then(values => {
        running = undefined
        return values && values.length ? values : undefined
      })
    return running
  }

  function republish () {
    run(selfPosition()).then(values => {
      if (values) {
        app.handleMessage(plugin.id, {
          context: 'vessels.' + app.selfId,
          updates: [{ timestamp: new Date().toISOString(), values }]
        })
      }
    })
  }

  // Coming high and low tides in the shape of the 'tides' resource of signalk-tides.
  function tideForecast () {
    const position = selfPosition()
    if (!validPosition(position)) return Promise.reject(new Error('No position'))
    return run(position).then(() => {
      const view = lastView
      let extremes = view && view.extremes && view.extremes.length ? view.extremes : null
      if (!extremes && view && view.predicted) extremes = extremesInSeries(view.predicted)
      if (!view || !view.station || !extremes || extremes.length === 0) {
        throw new Error(`No ${spec.name} tide predictions for this position`)
      }
      const now = currentTime()
      return {
        datum: view.datum,
        units: 'meters',
        station: {
          id: `${spec.optionKey}/${view.station.id}`,
          name: view.station.name,
          latitude: view.station.latitude,
          longitude: view.station.longitude
        },
        extremes: extremes
          .filter(p => p.time > now)
          .map(p => {
            const high = p.flag === 'high'
            return { time: p.time.toISOString(), level: round(p.value), high, low: !high, label: high ? 'High' : 'Low' }
          })
      }
    })
  }

  return {
    group: 'tides',
    optionKey: spec.optionKey,
    title: spec.title,
    tideForecast,
    derivedFrom: ['navigation.position'],
    properties: spec.properties || {},
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

// --- helpers for providers ---------------------------------------------------------------

function round (v) {
  return Math.round(v * 1000) / 1000
}

function validPosition (p) {
  return !!p && typeof p.latitude === 'number' && typeof p.longitude === 'number' &&
    isFinite(p.latitude) && isFinite(p.longitude)
}

function noData (message) {
  return Object.assign(new Error(message), { noData: true })
}

// Not worth reporting as an error, e.g. the boat is outside the provider's area.
function quiet (message) {
  return Object.assign(new Error(message), { quiet: true })
}

// Nearest item with latitude/longitude, and its distance in metres.
function nearest (list, position, filter) {
  let best = null
  let bestDistance = Infinity
  for (const item of list || []) {
    if (filter && !filter(item)) continue
    const d = geolib.getDistance(position, { latitude: item.latitude, longitude: item.longitude })
    if (d < bestDistance) {
      best = item
      bestDistance = d
    }
  }
  return best ? { item: best, distance: bestDistance } : null
}

function textRequest (req, accept) {
  return req
    .set('User-Agent', USER_AGENT)
    .set('Accept', accept)
    .timeout(REQUEST_TIMEOUT)
    .buffer(true)
    .parse((res, done) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => done(null, text))
    })
    .then(res => ({ status: res.status, text: res.body }), err => {
      // Keep the start of the answer: services explain errors there
      const body = err.response && typeof err.response.body === 'string' ? err.response.body : ''
      if (err.status) throw new Error(`HTTP ${err.status}${body ? ': ' + body.slice(0, 200) : ''}`)
      throw err
    })
}

function parseJson (text) {
  if (text === '' || text === undefined) return null
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error('bad JSON: ' + String(text).slice(0, 120))
  }
}

function getText (url, accept) {
  return textRequest(superagent.get(url), accept || '*/*').then(r => r.text)
}

function getJson (url) {
  return textRequest(superagent.get(url), 'application/json, application/geo+json').then(r => parseJson(r.text))
}

function postJson (url, body) {
  return textRequest(superagent.post(url).type('json').send(body), 'application/json').then(r => parseJson(r.text))
}

// Default fetchers, replaceable in tests through deps.
const http = { getText, getJson, postJson }

/*
 * A station list kept in memory and in a file in the plugin's data folder, fetched again after
 * maxAge. An old list is still used when fetching fails. Call from update(): it queues the fetch
 * as a job when due and returns the list it has (or null).
 */
function stationList (ctx, name, maxAge, fetch) {
  const fs = require('fs')
  const path = require('path')
  const app = ctx.app
  const key = `stations:${name}`
  let list = ctx.state[key]
  const dir = typeof app.getDataDirPath === 'function' ? app.getDataDirPath() : app.config && app.config.configPath
  const file = dir ? path.join(dir, `${name}.json`) : null
  if (!list && file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (saved && Array.isArray(saved.stations)) list = ctx.state[key] = saved
    } catch (err) {
      // no file yet
    }
  }
  if (!list || ctx.t - list.fetchedAt >= maxAge) {
    ctx.job(key, 'station list', () => Promise.resolve(fetch()).then(stations => {
      if (!Array.isArray(stations) || stations.length === 0) throw new Error('no stations in the answer')
      const fresh = ctx.state[key] = { stations, fetchedAt: ctx.t }
      if (file) {
        fs.writeFile(file, JSON.stringify(fresh), err => {
          if (err) ctx.debug(`could not save ${file}: ${err.message}`)
        })
      }
    }))
  }
  return list ? list.stations : null
}

const DAY = 24 * HOUR

module.exports = createProvider
module.exports.round = round
module.exports.validPosition = validPosition
module.exports.noData = noData
module.exports.quiet = quiet
module.exports.nearest = nearest
module.exports.buildUrl = buildUrl
module.exports.http = http
module.exports.stationList = stationList
module.exports.HOUR = HOUR
module.exports.MINUTE = MINUTE
module.exports.DAY = DAY
