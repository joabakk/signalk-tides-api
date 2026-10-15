/*
 * Offline tests for the tides resource (/signalk/v2/api/resources/tides):
 * the plugin's registration with the server, and the NOAA provider's forecast.
 * The Kartverket forecast is tested in kartverket.test.js.
 * NOAA itself is not contacted: superagent.get is replaced for the duration of each test.
 *
 * Run with: node test/tides-resource.test.js
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const superagent = require('superagent')

const STATIONS = {
  stations: [
    { id: '9447130', reference_id: '9447130', name: 'Seattle', lat: 47.6026, lng: -122.3393 },
    { id: '8443970', reference_id: '8443970', name: 'Boston', lat: 42.3539, lng: -71.0503 }
  ]
}
const NEAR_BOSTON = { latitude: 42.30, longitude: -70.95 }
const NEAR_SEATTLE = { latitude: 47.60, longitude: -122.40 }
const PREDICTIONS = {
  predictions: [
    { t: '2026-10-14 04:55', v: '0.198', type: 'L' },
    { t: '2026-10-14 11:02', v: '3.004', type: 'H' },
    { t: '2026-10-14 17:20', v: '0.241', type: 'L' }
  ]
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Replaces superagent.get with a stub that answers from `respond(url)`:
// return { body } for success, or throw an Error (optionally with .response) for failure.
function stubNoaa (respond) {
  const original = superagent.get
  const urls = []
  superagent.get = url => {
    urls.push(new URL(url))
    return {
      set () { return this },
      then (ok, fail) {
        return Promise.resolve().then(() => respond(url)).then(ok, fail)
      }
    }
  }
  return { urls, restore: () => { superagent.get = original } }
}

function configDir () {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tides-resource-'))
  fs.writeFileSync(path.join(configPath, 'noaastations.json'), JSON.stringify(STATIONS))
  return configPath
}

function noaaSetup (state) {
  const app = {
    config: { configPath: configDir() },
    errors: [],
    pluginErrors: [],
    debug () {},
    error (m) { this.errors.push(m) },
    setPluginError (m) { this.pluginErrors.push(m) },
    use () { throw new Error('app.use should not be called') },
    getSelfPath (p) {
      if (p === 'navigation.position.value') return state.position
      if (p === 'navigation.datetime.value') return state.now
      return undefined
    }
  }
  const calc = require('../calcs/noaa.js')(app, {})
  return { app, calc }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50)) // stations file is read asynchronously

// --- NOAA forecast -------------------------------------------------------------

test('NOAA: forecast for the closest station in the signalk-tides shape', async () => {
  const noaa = stubNoaa(() => ({ body: PREDICTIONS }))
  try {
    const { calc } = noaaSetup({ position: NEAR_BOSTON, now: '2026-10-14T06:00:00Z' })
    await settle()
    const forecast = await calc.tideForecast()

    const q = noaa.urls[0].searchParams
    assert.strictEqual(noaa.urls[0].origin + noaa.urls[0].pathname, 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter')
    assert.strictEqual(q.get('station'), '8443970')
    assert.strictEqual(q.get('product'), 'predictions')
    assert.strictEqual(q.get('begin_date'), '20261014 06:00')
    assert.strictEqual(q.get('range'), '168')
    assert.strictEqual(q.get('datum'), 'MLLW')
    assert.strictEqual(q.get('time_zone'), 'gmt')
    assert.strictEqual(q.get('units'), 'metric')
    assert.strictEqual(q.get('interval'), 'hilo')
    assert.strictEqual(q.get('format'), 'json')

    assert.deepStrictEqual(forecast, {
      datum: 'MLLW',
      units: 'meters',
      station: { id: 'noaa/8443970', name: 'Boston', latitude: 42.3539, longitude: -71.0503 },
      extremes: [ // 04:55 has passed at 06:00
        { time: '2026-10-14T11:02:00.000Z', level: 3.004, high: true, low: false, label: 'High' },
        { time: '2026-10-14T17:20:00.000Z', level: 0.241, high: false, low: true, label: 'Low' }
      ]
    })
  } finally {
    noaa.restore()
  }
})

test('NOAA: caches the forecast for an hour, asks again for another station', async () => {
  const noaa = stubNoaa(() => ({ body: PREDICTIONS }))
  try {
    const state = { position: NEAR_BOSTON, now: '2026-10-14T06:00:00Z' }
    const { calc } = noaaSetup(state)
    await settle()
    await calc.tideForecast()
    state.now = '2026-10-14T06:59:00Z'
    await calc.tideForecast()
    assert.strictEqual(noaa.urls.length, 1, 'cached within the hour')
    state.position = NEAR_SEATTLE
    const seattle = await calc.tideForecast()
    assert.strictEqual(noaa.urls.length, 2)
    assert.strictEqual(seattle.station.name, 'Seattle')
    state.now = '2026-10-14T08:00:00Z'
    await calc.tideForecast()
    assert.strictEqual(noaa.urls.length, 3, 'asks again after an hour')
  } finally {
    noaa.restore()
  }
})

test('NOAA: no position, no stations, a NOAA error and an unreachable NOAA reject', async () => {
  const noPosition = noaaSetup({})
  await settle()
  await assert.rejects(noPosition.calc.tideForecast(), /No position/)

  const empty = noaaSetup({ position: NEAR_BOSTON })
  fs.writeFileSync(path.join(empty.app.config.configPath, 'noaastations.json'), '{"stations":[]}')
  const emptyCalc = require('../calcs/noaa.js')(empty.app, {})
  await settle()
  await assert.rejects(emptyCalc.tideForecast(), /NOAA stations not loaded/)

  let noaa = stubNoaa(() => {
    const err = new Error('Bad Request')
    err.response = { body: { error: { message: 'No Predictions data was found.' } } }
    throw err
  })
  try {
    const { calc } = noaaSetup({ position: NEAR_BOSTON })
    await settle()
    await assert.rejects(calc.tideForecast(), /No Predictions data was found/)
  } finally {
    noaa.restore()
  }

  noaa = stubNoaa(() => { throw new Error('getaddrinfo ENOTFOUND api.tidesandcurrents.noaa.gov') })
  try {
    const { app, calc } = noaaSetup({ position: NEAR_BOSTON })
    await settle()
    await assert.rejects(calc.tideForecast(), /ENOTFOUND/)
    assert.ok(app.pluginErrors.some(m => m.includes('ENOTFOUND')))
  } finally {
    noaa.restore()
  }
})

test('NOAA: the calculator asks from the current UTC hour, not month', async () => {
  const noaa = stubNoaa(() => ({ body: PREDICTIONS }))
  try {
    const { calc } = noaaSetup({ position: NEAR_BOSTON, now: '2026-10-14T06:07:00Z' })
    await settle()
    await calc.calculator(NEAR_BOSTON)
    assert.strictEqual(noaa.urls[0].searchParams.get('begin_date'), '20261014 06:07')
  } finally {
    noaa.restore()
  }
})

// --- registration by the plugin ---------------------------------------------------

function pluginSetup (props) {
  const providers = []
  const app = {
    config: { configPath: configDir() },
    selfId: 'x',
    debug () {},
    error () {},
    setPluginError () {},
    setPluginStatus () {},
    handleMessage () {},
    getSelfPath () {},
    registerResourceProvider (provider) { providers.push(provider) },
    use () { throw new Error('app.use should not be called') }
  }
  const plugin = require('../index.js')(app)
  plugin.start(props)
  return { plugin, providers }
}

test('plugin: registers a read-only tides resource provider', async () => {
  const { plugin, providers } = pluginSetup({ tides: {} })
  try {
    assert.strictEqual(providers.length, 1)
    assert.strictEqual(providers[0].type, 'tides')
    const m = providers[0].methods
    assert.deepStrictEqual(Object.keys(m).sort(), ['deleteResource', 'getResource', 'listResources', 'setResource'])
    await assert.rejects(m.setResource('x', {}), /Read-only/)
    await assert.rejects(m.deleteResource('x'), /Read-only/)
    await assert.rejects(m.getResource('x'), /Not implemented/)
  } finally {
    plugin.stop()
  }
})

test('plugin: the resource comes from an enabled provider', async () => {
  const none = pluginSetup({ tides: {} })
  try {
    await assert.rejects(none.providers[0].methods.listResources({}), /No tide provider with forecasts is enabled/)
  } finally {
    none.plugin.stop()
  }
  const worldtidesOnly = pluginSetup({ tides: { worldtides: true } })
  try {
    await assert.rejects(worldtidesOnly.providers[0].methods.listResources({}), /No tide provider with forecasts is enabled/)
  } finally {
    worldtidesOnly.plugin.stop()
  }
  // Kartverket enabled: its forecast is asked (and rejects here, as there is no position)
  const kartverket = pluginSetup({ tides: { kartverket: true } })
  try {
    await assert.rejects(kartverket.providers[0].methods.listResources({}), /No position/)
  } finally {
    kartverket.plugin.stop()
  }
})

test('plugin: station-based providers come before the model and offline fallbacks', () => {
  const { forecastOrder } = require('../index.js')
  const calc = (optionKey, fallback) => ({ optionKey, fallback, tideForecast () {} })
  const calcs = [calc('chs'), calc('kartverket'), calc('offline', true), calc('openmeteo', true), calc('rws'), { optionKey: 'worldtides' }]
  const keys = tides => forecastOrder(calcs, tides).map(c => c.optionKey)
  assert.deepStrictEqual(keys({ offline: true, openmeteo: true, kartverket: true, rws: true, worldtides: true }),
    ['kartverket', 'rws', 'offline', 'openmeteo'])
  assert.deepStrictEqual(keys({ openmeteo: true }), ['openmeteo'])
  assert.deepStrictEqual(keys({}), [])
  // the real providers say which are fallbacks
  const loaded = fs.readdirSync(path.join(__dirname, '..', 'calcs'))
    .map(f => require(path.join('..', 'calcs', f))({ config: { configPath: configDir() }, debug () {}, error () {} }, { properties: {} }))
  const fallbacks = loaded.filter(c => c && c.fallback).map(c => c.optionKey).sort()
  assert.deepStrictEqual(fallbacks, ['offline', 'openmeteo'])
})

test('plugin: the resource can be turned off', () => {
  const { plugin, providers } = pluginSetup({ tidesResource: false, tides: { kartverket: true } })
  try {
    assert.strictEqual(providers.length, 0)
  } finally {
    plugin.stop()
  }
  const schema = plugin.schema()
  assert.strictEqual(schema.properties.tidesResource.type, 'boolean')
  assert.strictEqual(schema.properties.tidesResource.default, true)
})

test('plugin: servers without registerResourceProvider still start', () => {
  const app = {
    config: { configPath: configDir() },
    selfId: 'x',
    debug () {},
    error () {},
    setPluginError () {},
    getSelfPath () {}
  }
  const plugin = require('../index.js')(app)
  assert.doesNotThrow(() => plugin.start({ tides: {} }))
  plugin.stop()
})

;(async () => {
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`ok - ${t.name}`)
    } catch (err) {
      failed++
      console.log(`not ok - ${t.name}\n  ${err.stack.split('\n').join('\n  ')}`)
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`)
  process.exit(failed ? 1 : 0)
})()
