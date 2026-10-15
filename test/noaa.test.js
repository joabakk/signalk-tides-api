/*
 * Offline tests for calcs/noaa.js. Run with: node test/noaa.test.js
 * Fixtures: real NOAA CO-OPS responses captured 2026-10-15T17:30Z for San Francisco (9414290) -
 * water level, highs and lows, 6-minute predictions, an invalid-station error - and the water
 * level stations within 80 km. The prediction station list (noaa-prediction-stations.json) is made
 * in the documented format from real station ids. Data: NOAA, public domain.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const noaa = require('../calcs/noaa')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const SF = { latitude: 37.81, longitude: -122.47 }
const HALF_MOON_BAY = { latitude: 37.50, longitude: -122.48 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function answer (url) {
  const u = new URL(url)
  const q = u.searchParams
  if (u.pathname.endsWith('/stations.json')) return fixture(q.get('type') === 'waterlevels' ? 'noaa-live-gauges.json' : 'noaa-prediction-stations.json')
  if (q.get('station') !== '9414290') return fixture('noaa-live-unknown-station.json')
  if (q.get('product') === 'water_level') return fixture('noaa-live-water-level.json')
  if (q.get('interval') === 'hilo') return fixture('noaa-live-predictions-hilo.json')
  if (q.get('interval') === '6') return fixture('noaa-live-predictions-6min.json')
  return new Error('unexpected request')
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T17:30:47Z', position: opts.position || SF }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-'))
  const app = {
    selfId: 'x', pluginErrors: [], statuses: [], messages: [],
    debug () {}, error () {},
    setPluginError (m) { this.pluginErrors.push(m) }, setPluginStatus (m) { this.statuses.push(m) },
    handleMessage (id, d) { this.messages.push(d) },
    getDataDirPath: () => dataDir,
    getSelfPath (p) {
      if (p === 'navigation.datetime') return { value: state.now }
      if (p === 'navigation.position') return state.position ? { value: state.position } : undefined
    }
  }
  const urls = []
  const getJson = url => {
    urls.push(new URL(url))
    const a = (opts.answer || answer)(url)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = { id: 'tides-api', properties: { tides: { noaa: true } } }
  const calc = noaa(app, plugin, { getJson })
  const of = (product, interval) => urls.filter(u => u.searchParams.get('product') === product && (!interval || u.searchParams.get('interval') === interval))
  return { state, app, calc, urls, of }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

test('San Francisco: highs and lows, predicted and measured level above MLLW', async () => {
  const { calc, app } = setup()
  try {
    const v = byPath(await calc.calculator(SF))
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-15T21:24:00.000Z')
    assert.strictEqual(v['environment.tide.heightHigh'], 1.67)
    assert.strictEqual(v['environment.tide.timeLow'], '2026-10-16T04:34:00.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], 0.097)
    assert.ok(near(v['environment.tide.heightPredicted'], 1.195, 0.005), String(v['environment.tide.heightPredicted']))
    assert.strictEqual(v['environment.tide.heightObserved'], 1.394) // 17:24
    assert.strictEqual(v['environment.tide.heightNow'], 1.394)
    assert.ok(near(v['environment.tide.weatherEffect'], 0.213, 0.001), String(v['environment.tide.weatherEffect']))
    assert.ok(app.statuses[0].startsWith('NOAA San Francisco (MLLW), height now from measurement'), app.statuses[0])
    assert.deepStrictEqual(app.pluginErrors, [])
  } finally {
    calc.stop()
  }
})

test('sends the datagetter requests', async () => {
  const { calc, of, urls } = setup()
  try {
    await calc.calculator(SF)
    assert.deepStrictEqual(urls.slice(0, 2).map(u => u.searchParams.get('type')), ['tidepredictions', 'waterlevels'])
    const hilo = of('predictions', 'hilo')[0]
    assert.strictEqual(hilo.origin + hilo.pathname, noaa.DATA_URL)
    const q = Object.fromEntries(hilo.searchParams)
    assert.deepStrictEqual(q, {
      application: 'signalk-tides-api', datum: 'MLLW', time_zone: 'gmt', units: 'metric', format: 'json',
      product: 'predictions', interval: 'hilo', station: '9414290', begin_date: '20261015 16:30', range: '169'
    })
    assert.strictEqual(of('water_level')[0].searchParams.get('begin_date'), '20261015 15:30')
    assert.strictEqual(of('water_level')[0].searchParams.get('range'), '2')
  } finally {
    calc.stop()
  }
})

test('caches: measured every 6 minutes, predictions when they run out', async () => {
  const { calc, state, of } = setup()
  try {
    await calc.calculator(SF)
    state.now = '2026-10-15T17:36:00Z'
    await calc.calculator(SF)
    assert.strictEqual(of('water_level').length, 1)
    state.now = '2026-10-15T17:37:00Z'
    await calc.calculator(SF)
    assert.strictEqual(of('water_level').length, 2)
    assert.strictEqual(of('predictions', '6').length, 1)
    assert.strictEqual(of('predictions', 'hilo').length, 1)
  } finally {
    calc.stop()
  }
})

test('subordinate station: highs and lows only, no gauge within 5 km', async () => {
  const hmb = setup({ position: HALF_MOON_BAY, answer: url => {
    const q = new URL(url).searchParams
    return q.get('station') === '9414131' && q.get('interval') === 'hilo' ? fixture('noaa-live-predictions-hilo.json') : answer(url)
  } })
  try {
    const v = byPath(await hmb.calc.calculator(HALF_MOON_BAY))
    assert.strictEqual(hmb.of('predictions', '6').length, 0)
    assert.strictEqual(hmb.of('water_level').length, 0)
    assert.strictEqual(v['environment.tide.heightHigh'], 1.67)
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
  } finally {
    hmb.calc.stop()
  }
})

test('NOAA error answers: no data for that series, reported, retried after an interval', async () => {
  const { calc, app, of, state } = setup({ answer: url => new URL(url).searchParams.get('product') === 'water_level' ? fixture('noaa-live-unknown-station.json') : answer(url) })
  try {
    const v = byPath(await calc.calculator(SF))
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.ok(typeof v['environment.tide.heightNow'] === 'number')
    assert.ok(app.pluginErrors.some(m => m.includes('The station is not a valid station')), app.pluginErrors.join('; '))
    state.now = '2026-10-15T17:50:00Z'
    await calc.calculator(SF)
    assert.strictEqual(of('water_level').length, 1, 'waits at least 30 minutes')
  } finally {
    calc.stop()
  }
  const http400 = setup({ answer: url => new URL(url).searchParams.get('interval') === 'hilo'
    ? new Error('HTTP 400: {"error": {"message":"No Predictions data was found. Please make sure the Datum input is valid."}}') : answer(url) })
  try {
    await http400.calc.calculator(SF)
    assert.ok(http400.app.pluginErrors.some(m => m.includes('No Predictions data was found')), http400.app.pluginErrors.join('; '))
  } finally {
    http400.calc.stop()
  }
})

test('missing values ("") are skipped, not read as 0', async () => {
  const wl = fixture('noaa-live-water-level.json')
  wl.data.push({ t: '2026-10-15 17:30', v: '', s: '', f: '0,0,0,0', q: 'p' })
  const { calc } = setup({ answer: url => new URL(url).searchParams.get('product') === 'water_level' ? wl : answer(url) })
  try {
    assert.strictEqual(byPath(await calc.calculator(SF))['environment.tide.heightObserved'], 1.394)
  } finally {
    calc.stop()
  }
})

test('tides resource: the next 7 days of highs and lows, as before', async () => {
  const { calc } = setup()
  try {
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'MLLW')
    assert.deepStrictEqual(f.station, { id: 'noaa/9414290', name: 'San Francisco', latitude: 37.8063, longitude: -122.4659 })
    assert.deepStrictEqual(f.extremes[0], { time: '2026-10-15T21:24:00.000Z', level: 1.67, high: true, low: false, label: 'High' })
  } finally {
    calc.stop()
  }
  const far = setup({ position: { latitude: 30, longitude: -140 } })
  try {
    await assert.rejects(far.calc.tideForecast(), /No NOAA tide predictions for this position/)
  } finally {
    far.calc.stop()
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
