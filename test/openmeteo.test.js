/*
 * Offline tests for calcs/openmeteo.js. Run with: node test/openmeteo.test.js
 * The fixtures are synthetic answers in Open-Meteo's documented format (see their _note).
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const openmeteo = require('../calcs/openmeteo')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const FREDRIKSTAD = { latitude: 59.21, longitude: 10.95 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function mockApp (state) {
  return {
    selfId: 'x',
    pluginErrors: [],
    statuses: [],
    messages: [],
    debug () {},
    error () {},
    setPluginError (m) { this.pluginErrors.push(m) },
    setPluginStatus (m) { this.statuses.push(m) },
    handleMessage (id, d) { this.messages.push(d) },
    getSelfPath (p) {
      if (p === 'navigation.datetime') return { value: state.now }
      if (p === 'navigation.position') return state.position ? { value: state.position } : undefined
    }
  }
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-16T14:30:00Z', position: FREDRIKSTAD }
  const app = mockApp(state)
  const urls = []
  const getJson = url => {
    urls.push(new URL(url))
    if (opts.answer instanceof Error) return Promise.reject(opts.answer)
    return Promise.resolve(opts.answer || fixture('openmeteo-fredrikstad.json'))
  }
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ openmeteo: true }, opts.tides) } }
  const calc = openmeteo(app, plugin, { getJson })
  return { state, app, calc, urls }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

test('forecast level, its air pressure part, and the tide without it', async () => {
  const { calc, app } = setup()
  try {
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.strictEqual(v['environment.tide.heightForecast'], 0.061)
    assert.strictEqual(v['environment.tide.weatherEffect'], -0.082)
    assert.strictEqual(v['environment.tide.heightPredicted'], 0.143)
    assert.strictEqual(v['environment.tide.heightNow'], 0.061)
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    // highs every 12.42 h from 2026-10-15T14:00Z in the synthetic data
    assert.ok(near(new Date(v['environment.tide.timeHigh']) - new Date('2026-10-16T14:50:24Z'), 0, 15 * 60e3), v['environment.tide.timeHigh'])
    assert.ok(near(v['environment.tide.heightHigh'], 0.15, 0.01))
    assert.ok(near(new Date(v['environment.tide.timeLow']) - new Date('2026-10-16T21:03:00Z'), 0, 15 * 60e3), v['environment.tide.timeLow'])
    assert.ok(app.statuses[0].includes('Open-Meteo model grid cell (MSL), height now from forecast'))
    assert.ok(app.statuses[0].includes('not for coastal navigation'))
  } finally {
    calc.stop()
  }
})

test('sends the documented request', async () => {
  const { calc, urls } = setup()
  try {
    await calc.calculator(FREDRIKSTAD)
    const u = urls[0]
    assert.strictEqual(u.origin + u.pathname, openmeteo.DEFAULT_API_URL)
    assert.strictEqual(u.searchParams.get('latitude'), '59.210')
    assert.strictEqual(u.searchParams.get('longitude'), '10.950')
    assert.strictEqual(u.searchParams.get('hourly'), 'sea_level_height_msl,invert_barometer_height')
    assert.strictEqual(u.searchParams.get('timeformat'), 'unixtime')
    assert.strictEqual(u.searchParams.get('timezone'), 'GMT')
    assert.strictEqual(u.searchParams.get('forecast_days'), '7')
  } finally {
    calc.stop()
  }
})

test('asks again after an hour or a 4 km move; at least 30 min apart', async () => {
  const { calc, urls, state } = setup()
  try {
    await calc.calculator(FREDRIKSTAD)
    state.now = '2026-10-16T15:29:00Z'
    await calc.calculator({ latitude: 59.22, longitude: 10.95 }) // ~1 km
    assert.strictEqual(urls.length, 1)
    await calc.calculator({ latitude: 59.30, longitude: 10.95 }) // ~10 km
    assert.strictEqual(urls.length, 2)
    state.now = '2026-10-16T16:30:00Z'
    await calc.calculator({ latitude: 59.30, longitude: 10.95 })
    assert.strictEqual(urls.length, 3)
  } finally {
    calc.stop()
  }
  const fast = setup({ tides: { openmeteoRefreshMinutes: 5 } })
  try {
    await fast.calc.calculator(FREDRIKSTAD)
    fast.state.now = '2026-10-16T14:50:00Z'
    await fast.calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fast.urls.length, 1, 'not below 30 min')
  } finally {
    fast.calc.stop()
  }
})

test('errors: the reason Open-Meteo gives, and a position on land', async () => {
  const bad = setup({ answer: { error: true, reason: 'Parameter hourly is invalid' } })
  try {
    assert.strictEqual(await bad.calc.calculator(FREDRIKSTAD), undefined)
    assert.ok(bad.app.pluginErrors.some(m => m.includes('Parameter hourly is invalid')))
  } finally {
    bad.calc.stop()
  }
  const land = setup({ answer: fixture('openmeteo-land.json') })
  try {
    assert.strictEqual(await land.calc.calculator(FREDRIKSTAD), undefined)
    assert.ok(land.app.pluginErrors.some(m => m.includes('no sea level for this position')))
    land.state.now = '2026-10-16T15:00:00Z'
    await land.calc.calculator(FREDRIKSTAD)
    assert.strictEqual(land.urls.length, 1, 'waits a whole interval')
  } finally {
    land.calc.stop()
  }
  const down = setup({ answer: new Error('HTTP 503: busy') })
  try {
    assert.strictEqual(await down.calc.calculator(FREDRIKSTAD), undefined)
    assert.ok(down.app.pluginErrors.some(m => m.includes('HTTP 503')))
  } finally {
    down.calc.stop()
  }
})

test('tides resource from the grid cell', async () => {
  const { calc } = setup()
  try {
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'MSL')
    assert.deepStrictEqual(f.station, { id: 'openmeteo/59.208,10.958', name: 'model grid cell', latitude: 59.208, longitude: 10.958 })
    assert.ok(f.extremes.length >= 20)
    assert.ok(f.extremes.every(e => e.time > '2026-10-16T14:30:00.000Z'))
  } finally {
    calc.stop()
  }
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
