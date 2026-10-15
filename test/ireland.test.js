/*
 * Offline tests for calcs/ireland.js. Run with: node test/ireland.test.js
 * Fixtures are real Marine Institute ERDDAP responses captured 2026-10-15T17:30Z, cut down to
 * Dublin Port; the station and gauge lists are the distinct stations of the captured rows, in the
 * same table format. Data: Marine Institute, CC BY 4.0.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ireland = require('../calcs/ireland')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const DUBLIN = { latitude: 53.345, longitude: -6.20 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function answer (url) {
  const u = decodeURIComponent(url)
  if (u.includes('imiTidePrediction.json?stationID,longitude,latitude')) return fixture('ireland-live-stations.json')
  if (u.includes('IrishNationalTideGaugeNetwork.json?station_id,latitude,longitude')) return fixture('ireland-live-gauges.json')
  if (u.includes('IMI_TidePrediction_HighLow.json') && u.includes('stationID="Dublin_Port"')) return fixture('ireland-live-highlow.json')
  if (u.includes('imiTidePrediction.json') && u.includes('stationID="Dublin_Port"')) return fixture('ireland-live-predictions.json')
  if (u.includes('IrishNationalTideGaugeNetwork.json') && u.includes('station_id="Dublin Port"')) return fixture('ireland-live-gauge.json')
  return new Error('HTTP 404: Error {\n    code=404;\n    message="Not Found: Your query produced no matching results.";\n}')
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T17:30:47Z', position: DUBLIN }
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ireland-'))
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
    urls.push(decodeURIComponent(url))
    const a = (opts.answer || answer)(url)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ ireland: true }, opts.tides) } }
  const calc = ireland(app, plugin, { getJson })
  const of = dataset => urls.filter(u => u.includes(`/${dataset}.json?`) && !u.includes('distinct()'))
  return { state, app, calc, urls, of, dataDir }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

test('reads ERDDAP tables', () => {
  assert.deepStrictEqual(ireland.readTable({ table: { columnNames: ['a', 'b'], rows: [[1, 'x'], [2, 'y']] } }), [{ a: 1, b: 'x' }, { a: 2, b: 'y' }])
  assert.throws(() => ireland.readTable({ error: 'x' }), /not an ERDDAP table/)
})

test('LAT: highs and lows shifted from OD Malin, predicted and measured level at Dublin Port', async () => {
  const { calc, app } = setup()
  try {
    const v = byPath(await calc.calculator(DUBLIN))
    // LAT - OD Malin at Dublin Port: 2.25 - (-0.21) = 2.46
    assert.strictEqual(v['environment.tide.timeLow'], '2026-10-15T19:50:00.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], 1.232) // -1.228 + 2.46
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-16T02:30:00.000Z')
    assert.strictEqual(v['environment.tide.heightHigh'], 3.648) // 1.188 + 2.46
    assert.ok(near(v['environment.tide.heightPredicted'], 2.2, 0.02), String(v['environment.tide.heightPredicted']))
    assert.strictEqual(v['environment.tide.heightObserved'], 2.233) // 17:25
    assert.strictEqual(v['environment.tide.heightNow'], 2.233)
    assert.ok(near(v['environment.tide.weatherEffect'], -0.017, 0.002), String(v['environment.tide.weatherEffect']))
    assert.ok(app.statuses[0].startsWith('Marine Institute Dublin Port (LAT), height now from measurement'), app.statuses[0])
    assert.deepStrictEqual(app.pluginErrors, [])
  } finally {
    calc.stop()
  }
})

test('OD Malin: values as given', async () => {
  const { calc } = setup({ tides: { irelandDatum: 'ODM' } })
  try {
    const v = byPath(await calc.calculator(DUBLIN))
    assert.strictEqual(v['environment.tide.heightLow'], -1.228)
    assert.strictEqual(v['environment.tide.heightObserved'], -0.225)
  } finally {
    calc.stop()
  }
})

test('sends ERDDAP queries for the station, cached until they run out', async () => {
  const { calc, state, of, urls } = setup()
  try {
    await calc.calculator(DUBLIN)
    assert.strictEqual(urls.filter(u => u.includes('distinct()')).length, 2, 'station and gauge lists')
    assert.ok(of('IMI_TidePrediction_HighLow')[0].endsWith('/IMI_TidePrediction_HighLow.json?time,tide_time_category,Water_Level_ODMalin&stationID="Dublin_Port"&time>=2026-10-15T16:30:47Z&time<=2026-10-22T17:30:47Z'), of('IMI_TidePrediction_HighLow')[0])
    assert.ok(of('IrishNationalTideGaugeNetwork')[0].includes('station_id="Dublin Port"&time>=2026-10-15T15:30:47Z&time<=2026-10-15T17:30:47Z'))
    assert.ok(urls[0].startsWith('https://erddap.marine.ie/erddap/tabledap/'))
    state.now = '2026-10-15T17:39:00Z'
    await calc.calculator(DUBLIN)
    assert.strictEqual(urls.length, 5)
    state.now = '2026-10-15T17:41:00Z'
    await calc.calculator(DUBLIN)
    assert.strictEqual(of('IrishNationalTideGaugeNetwork').length, 2)
    assert.strictEqual(of('imiTidePrediction').length, 1)
    // the captured highs and lows end 2026-10-16T14:40, less than a day ahead: asked again, but
    // at most once an hour
    assert.strictEqual(of('IMI_TidePrediction_HighLow').length, 1)
    state.now = '2026-10-15T18:31:00Z'
    await calc.calculator(DUBLIN)
    assert.strictEqual(of('IMI_TidePrediction_HighLow').length, 2)
  } finally {
    calc.stop()
  }
})

test('modelled stations: high/low name without _MODELLED; no gauge nearby, no measurement', async () => {
  const { calc, of } = setup({ answer: url => /HighLow|imiTidePrediction\.json\?time/.test(url) && /Wicklow/.test(decodeURIComponent(url)) ? fixture(/HighLow/.test(url) ? 'ireland-live-highlow.json' : 'ireland-live-predictions.json') : answer(url) })
  const wicklow = { latitude: 52.98, longitude: -6.03 }
  try {
    const v = byPath(await calc.calculator(wicklow))
    assert.ok(of('IMI_TidePrediction_HighLow')[0].includes('stationID="Wicklow"'))
    assert.ok(of('imiTidePrediction')[0].includes('stationID="Wicklow_MODELLED"'))
    assert.strictEqual(of('IrishNationalTideGaugeNetwork').length, 0)
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.ok(typeof v['environment.tide.heightNow'] === 'number')
  } finally {
    calc.stop()
  }
})

test('far from any station: quiet; a gauge without recent data is not an error', async () => {
  const far = setup()
  try {
    assert.strictEqual(await far.calc.calculator({ latitude: 50.0, longitude: -10.0 }), undefined)
    assert.deepStrictEqual(far.app.pluginErrors, [])
  } finally {
    far.calc.stop()
  }
  const silent = setup({ answer: url => /IrishNationalTideGaugeNetwork\.json\?time/.test(url) ? answer('none') : answer(url) })
  try {
    const v = byPath(await silent.calc.calculator(DUBLIN))
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.ok(typeof v['environment.tide.heightNow'] === 'number')
    assert.deepStrictEqual(silent.app.pluginErrors, [])
  } finally {
    silent.calc.stop()
  }
})

test('tides resource in LAT', async () => {
  const { calc } = setup()
  try {
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'LAT')
    assert.deepStrictEqual(f.station, { id: 'ireland/Dublin_Port', name: 'Dublin Port', latitude: 53.34574, longitude: -6.22166 })
    assert.deepStrictEqual(f.extremes[0], { time: '2026-10-15T19:50:00.000Z', level: 1.232, high: false, low: true, label: 'Low' })
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
