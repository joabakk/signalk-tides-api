/*
 * Offline tests for calcs/bsh.js. Run with: node test/bsh.test.js
 * Fixtures are real items of the BSH Water Level Forecast API captured 2026-11-06T16:31Z:
 * Alte Weser lighthouse (North Sea, with tide predictions) and Althagen (Baltic, forecast and
 * measurement only). Data: BSH, CC BY 4.0.
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bsh = require('../calcs/bsh')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const ALTE_WESER = fixture('bsh-live-alte_weser_leuchtturm.json')
const ALTHAGEN = fixture('bsh-live-althagen.json')
const NEAR_ALTE_WESER = { latitude: 53.85, longitude: 8.15 }
const NEAR_ALTHAGEN = { latitude: 54.37, longitude: 12.42 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// stations inside the requested bbox, as the API answers
function answer (url) {
  const u = new URL(url)
  if (u.pathname.endsWith('/items')) {
    const [w, s, e, n] = u.searchParams.get('bbox').split(',').map(Number)
    const features = [ALTE_WESER, ALTHAGEN].filter(f => {
      const [lon, lat] = f.geometry.coordinates
      return lon >= w && lon <= e && lat >= s && lat <= n
    })
    return { type: 'FeatureCollection', numberReturned: features.length, features }
  }
  if (u.pathname.endsWith('/items/alte_weser_leuchtturm')) return ALTE_WESER
  if (u.pathname.endsWith('/items/althagen')) return ALTHAGEN
  return new Error('HTTP 404: {"title":"Not Found"}')
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-11-06T16:31:09Z', position: opts.position || NEAR_ALTE_WESER }
  const app = {
    selfId: 'x', pluginErrors: [], statuses: [], messages: [],
    debug () {}, error () {},
    setPluginError (m) { this.pluginErrors.push(m) }, setPluginStatus (m) { this.statuses.push(m) },
    handleMessage (id, d) { this.messages.push(d) },
    getSelfPath (p) {
      if (p === 'navigation.datetime') return { value: state.now }
      if (p === 'navigation.position') return state.position ? { value: state.position } : undefined
    }
  }
  const urls = []
  const getJson = url => {
    urls.push(new URL(url))
    const a = answer(url)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = opts.plugin || { id: 'tides-api', properties: { tides: Object.assign({ bsh: true }, opts.tides) } }
  const calc = bsh(app, plugin, { getJson })
  return { state, app, calc, urls, plugin }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

test('reads a station: cm above gauge zero, times with their offset', () => {
  const st = bsh.readStation(ALTE_WESER)
  assert.deepStrictEqual([st.id, st.name, st.gaugeZeroNhn, st.chartDatum], ['alte_weser_leuchtturm', 'Alte Weser, Leuchtturm', -498, 287])
  assert.deepStrictEqual(st.extremes[1], { time: new Date('2026-11-06T21:19:00Z'), value: 630, flag: 'high' })
  assert.ok(st.predicted.length > 900 && st.observed.length > 50 && st.forecast.length > 800)
  const baltic = bsh.readStation(ALTHAGEN)
  assert.strictEqual(baltic.extremes.length, 0)
  assert.strictEqual(baltic.predicted.length, 0)
})

test('Alte Weser above chart datum: highs and lows, prediction, forecast and measurement', async () => {
  const { calc, app } = setup()
  try {
    const v = byPath(await calc.calculator(NEAR_ALTE_WESER))
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-11-06T21:19:00.000Z')
    assert.strictEqual(v['environment.tide.heightHigh'], 3.43) // 630 - 287 cm
    assert.strictEqual(v['environment.tide.timeLow'], '2026-11-07T03:43:00.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], 0.82)
    assert.strictEqual(v['environment.tide.heightObserved'], 0.47) // 334 cm at 16:10Z
    assert.strictEqual(v['environment.tide.heightNow'], 0.47)
    assert.strictEqual(v['environment.tide.weatherEffect'], -0.33) // measured 334, predicted 367
    assert.ok(near(v['environment.tide.heightPredicted'], 0.963, 0.002), String(v['environment.tide.heightPredicted']))
    assert.ok(near(v['environment.tide.heightForecast'], 0.664, 0.002), String(v['environment.tide.heightForecast']))
    assert.ok(app.statuses[0].startsWith('BSH Alte Weser, Leuchtturm (CD), height now from measurement'), app.statuses[0])
    assert.deepStrictEqual(app.pluginErrors, [])
  } finally {
    calc.stop()
  }
})

test('NHN: the gauge zero is 498 cm below NHN', async () => {
  const { calc } = setup({ tides: { bshDatum: 'NHN' } })
  try {
    const v = byPath(await calc.calculator(NEAR_ALTE_WESER))
    assert.strictEqual(v['environment.tide.heightHigh'], 1.32)
    assert.strictEqual(v['environment.tide.heightObserved'], -1.64)
  } finally {
    calc.stop()
  }
})

test('requests: a bbox search, then the station at the refresh interval; a new search after 5 km', async () => {
  const { calc, state, urls } = setup()
  try {
    await calc.calculator(NEAR_ALTE_WESER)
    assert.strictEqual(urls.length, 1, 'the search answer holds the station data')
    const q = urls[0].searchParams
    assert.strictEqual(urls[0].origin + urls[0].pathname, 'https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast/collections/waterlevelforecastdata/items')
    assert.strictEqual(q.get('f'), 'json')
    const [w, s, e, n] = q.get('bbox').split(',').map(Number)
    assert.ok(w < 8.15 && e > 8.15 && s < 53.85 && n > 53.85 && n - s < 0.7)
    state.now = '2026-11-06T16:45:00Z'
    await calc.calculator(NEAR_ALTE_WESER)
    assert.strictEqual(urls.length, 1)
    state.now = '2026-11-06T16:47:00Z'
    await calc.calculator(NEAR_ALTE_WESER)
    assert.strictEqual(urls[1].pathname.split('/').pop(), 'alte_weser_leuchtturm')
    await calc.calculator({ latitude: 53.90, longitude: 8.15 }) // 5.6 km
    assert.ok(urls[2].pathname.endsWith('/items'), 'searched again')
  } finally {
    calc.stop()
  }
})

test('Baltic (Althagen): forecast and measurement, no highs and lows, no tides resource answer', async () => {
  const { calc, plugin } = setup({ position: NEAR_ALTHAGEN })
  try {
    const v = byPath(await calc.calculator(NEAR_ALTHAGEN))
    assert.strictEqual(v['environment.tide.heightHigh'], undefined)
    assert.strictEqual(v['environment.tide.heightObserved'], 0.21) // 519 - 498 cm, 16:00Z
    assert.strictEqual(v['environment.tide.heightForecast'], 0.21)
    assert.strictEqual(plugin.tideDeltasAt.bsh.extremes, false, 'the fallbacks can add predictions here')
    await assert.rejects(calc.tideForecast(), /No BSH tide predictions/)
  } finally {
    calc.stop()
  }
})

test('far from the coast: quiet; tides resource above chart datum', async () => {
  const far = setup({ position: { latitude: 52.5, longitude: 13.4 } })
  try {
    assert.strictEqual(await far.calc.calculator({ latitude: 52.5, longitude: 13.4 }), undefined)
    assert.deepStrictEqual(far.app.pluginErrors, [])
  } finally {
    far.calc.stop()
  }
  const { calc } = setup()
  try {
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'CD')
    assert.deepStrictEqual(f.station, { id: 'bsh/alte_weser_leuchtturm', name: 'Alte Weser, Leuchtturm', latitude: 53.863333, longitude: 8.1275 })
    assert.deepStrictEqual(f.extremes[0], { time: '2026-11-06T21:19:00.000Z', level: 3.43, high: true, low: false, label: 'High' })
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
