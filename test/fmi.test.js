/*
 * Offline tests for calcs/fmi.js. Run with: node test/fmi.test.js
 * Fixtures are real FMI responses captured 2026-10-15T16:19Z: the sea level forecast for
 * 60.15,24.95 (Helsinki) and the latest values of all 14 tide gauges. Data: FMI, CC BY 4.0.
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const fmi = require('../calcs/fmi')

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const HELSINKI = { latitude: 60.15, longitude: 24.95 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function answer (url) {
  const q = new URL(url).searchParams.get('storedquery_id')
  if (q === 'fmi::forecast::sealevel::point::simple') return fixture('fmi-live-forecast-helsinki.xml')
  if (q === 'fmi::observations::mareograph::simple') return fixture('fmi-live-mareograph.xml')
  return new Error('HTTP 400: <ExceptionText>Unknown stored query</ExceptionText>')
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T16:18:31Z', position: HELSINKI }
  const app = {
    selfId: 'x', pluginErrors: [], statuses: [], messages: [], debugs: [],
    debug (m) { this.debugs.push(m) }, error () {},
    setPluginError (m) { this.pluginErrors.push(m) }, setPluginStatus (m) { this.statuses.push(m) },
    handleMessage (id, d) { this.messages.push(d) },
    getSelfPath (p) {
      if (p === 'navigation.datetime') return { value: state.now }
      if (p === 'navigation.position') return state.position ? { value: state.position } : undefined
    }
  }
  const urls = []
  const getText = url => {
    urls.push(new URL(url))
    const a = (opts.answer || answer)(url)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ fmi: true }, opts.tides) } }
  const calc = fmi(app, plugin, { getText })
  const of = q => urls.filter(u => u.searchParams.get('storedquery_id').includes(q))
  return { state, app, calc, urls, of }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

test('parses the simple feature format', () => {
  const rows = fmi.parseSimpleFeatures(fixture('fmi-live-forecast-helsinki.xml'))
  assert.strictEqual(rows.length, 98)
  assert.deepStrictEqual(rows[0], { latitude: 60.15, longitude: 24.95, time: new Date('2026-10-15T16:00:00Z'), parameter: 'SeaLevel', value: 33.8 })
  assert.strictEqual(rows[1].parameter, 'SeaLevelN2000')
  const gauges = fmi.parseSimpleFeatures(fixture('fmi-live-mareograph.xml'))
  assert.strictEqual(gauges.length, 14)
  // every gauge in the answer has a name
  for (const g of gauges) assert.ok(fmi.GAUGES.some(([, lat, lon]) => lat === g.latitude && lon === g.longitude), `${g.latitude} ${g.longitude}`)
  assert.throws(() => fmi.parseSimpleFeatures('<ExceptionReport><ExceptionText>Invalid latlon</ExceptionText></ExceptionReport>'), /Invalid latlon/)
})

test('MW: forecast and the measured level at Kaivopuisto', async () => {
  const { calc, app } = setup()
  try {
    const v = byPath(await calc.calculator(HELSINKI))
    assert.deepStrictEqual(v, {
      'environment.tide.heightForecast': 0.341, // 33.8 cm at 16:00, 34.8 at 17:00
      'environment.tide.heightObserved': 0.304, // 304 mm at 16:00
      'environment.tide.heightNow': 0.304
    })
    assert.ok(app.statuses[0].startsWith('FMI Helsinki Kaivopuisto (MW), height now from measurement'), app.statuses[0])
    assert.deepStrictEqual(app.pluginErrors, [])
  } finally {
    calc.stop()
  }
})

test('N2000: forecast in N2000, the measurement shifted by the forecast offset (21.1 cm)', async () => {
  const { calc } = setup({ tides: { fmiDatum: 'N2000' } })
  try {
    const v = byPath(await calc.calculator(HELSINKI))
    assert.strictEqual(v['environment.tide.heightForecast'], 0.552)
    assert.strictEqual(v['environment.tide.heightObserved'], 0.515)
  } finally {
    calc.stop()
  }
})

test('sends the expected requests and caches them', async () => {
  const { calc, state, of, urls } = setup()
  try {
    await calc.calculator(HELSINKI)
    const f = of('forecast')[0].searchParams
    assert.strictEqual(of('forecast')[0].origin + of('forecast')[0].pathname, 'https://opendata.fmi.fi/wfs')
    assert.strictEqual(f.get('latlon'), '60.15,24.95')
    assert.strictEqual(f.get('starttime'), '2026-10-15T15:18:31Z')
    assert.strictEqual(f.get('endtime'), '2026-10-17T16:18:31Z')
    assert.strictEqual(f.get('request'), 'getFeature')
    const o = of('mareograph')[0].searchParams
    assert.strictEqual(o.get('parameters'), 'watlev')
    assert.strictEqual(o.get('fmisid'), null, 'all gauges in one request')
    state.now = '2026-10-15T16:37:00Z'
    await calc.calculator(HELSINKI)
    assert.strictEqual(urls.length, 2)
    state.now = '2026-10-15T16:39:00Z'
    await calc.calculator(HELSINKI)
    assert.strictEqual(of('mareograph').length, 2)
    assert.strictEqual(of('forecast').length, 1)
    await calc.calculator({ latitude: 60.25, longitude: 24.95 }) // 11 km
    assert.strictEqual(of('forecast').length, 2)
    state.now = '2026-10-15T17:39:00Z'
    await calc.calculator({ latitude: 60.25, longitude: 24.95 })
    assert.strictEqual(of('forecast').length, 3)
  } finally {
    calc.stop()
  }
})

test('far from a gauge: forecast only; no forecast on land: nothing', async () => {
  const sea = setup()
  const archipelago = { latitude: 60.0, longitude: 21.5 } // 72 km from Hanko and Turku
  sea.state.position = archipelago
  try {
    const v = byPath(await sea.calc.calculator(archipelago))
    assert.deepStrictEqual(Object.keys(v).sort(), ['environment.tide.heightForecast', 'environment.tide.heightNow'])
    assert.ok(sea.app.statuses[0].startsWith('FMI forecast point (MW), height now from forecast'), sea.app.statuses[0])
  } finally {
    sea.calc.stop()
  }
  const empty = '<wfs:FeatureCollection timeStamp="2026-10-15T16:19:05Z" numberReturned="0" numberMatched="0"></wfs:FeatureCollection>'
  const land = setup({ answer: url => /forecast/.test(url) ? empty : answer(url) })
  const lake = { latitude: 62.0, longitude: 27.5 }
  land.state.position = lake
  try {
    assert.strictEqual(await land.calc.calculator(lake), undefined)
    assert.ok(land.app.pluginErrors.some(m => m.includes('no sea level forecast for this position')), land.app.pluginErrors.join('; '))
  } finally {
    land.calc.stop()
  }
})

test('old measurements are not used; an FMI error is reported', async () => {
  const { calc, state } = setup()
  try {
    state.now = '2026-10-15T18:40:00Z'
    const v = byPath(await calc.calculator(HELSINKI))
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightForecast'])
    assert.strictEqual(calc.tideForecast, undefined)
  } finally {
    calc.stop()
  }
  const bad = setup({ answer: () => new Error('HTTP 400: <ExceptionReport><ExceptionText>Invalid time interval</ExceptionText></ExceptionReport>') })
  try {
    assert.strictEqual(await bad.calc.calculator(HELSINKI), undefined)
    assert.ok(bad.app.pluginErrors.some(m => m.includes('Invalid time interval')), bad.app.pluginErrors.join('; '))
  } finally {
    bad.calc.stop()
  }
})

test('N2000 without an offset: the gauge is not named, as nothing from it is published', async () => {
  // N2000 values one second off the MW values: no offset to convert the measurement with
  const shifted = fixture('fmi-live-forecast-helsinki.xml')
    .replace(/:00:00Z(<\/BsWfs:Time>\s*<BsWfs:ParameterName>SeaLevelN2000<)/g, ':00:01Z$1')
  const { calc, app } = setup({ tides: { fmiDatum: 'N2000' }, answer: url => /forecast/.test(url) ? shifted : answer(url) })
  try {
    const v = byPath(await calc.calculator(HELSINKI))
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.ok(typeof v['environment.tide.heightForecast'] === 'number')
    assert.ok(app.statuses[0].startsWith('FMI forecast point (N2000)'), app.statuses[0])
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
