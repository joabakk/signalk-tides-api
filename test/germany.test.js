/*
 * Offline tests for calcs/germany.js. Run with: node test/germany.test.js
 * Fixtures are real PEGELONLINE responses captured 2026-10-15T17:30Z: the stations within 40 km of
 * Cuxhaven and Kiel (current measurements removed), and the last 2 hours of W at Cuxhaven
 * Steubenhöft and Kiel-Holtenau. Data: WSV, dl-de/zero-2-0.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const germany = require('../calcs/germany')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const CUXHAVEN = { latitude: 53.87, longitude: 8.72 }
const KIEL = { latitude: 54.37, longitude: 10.16 }
const CUX = 'aad49293-242a-43ad-a8b1-e91d7792c4b2'
const KIE = '3ad4013f-644b-47f5-a641-44b332bfecb2'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function answer (url) {
  if (url.includes('/stations.json?')) return fixture('germany-live-stations.json')
  if (url.includes(`/stations/${CUX}/W/measurements.json`)) return fixture('germany-live-cuxhaven-W.json')
  if (url.includes(`/stations/${KIE}/W/measurements.json`)) return fixture('germany-live-kiel-W.json')
  return new Error('HTTP 404: {"status":404,"message":"Station not found"}')
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T17:30:47Z', position: CUXHAVEN }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'germany-'))
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
    urls.push(url)
    const a = (opts.answer || answer)(url)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ germany: true }, opts.tides) } }
  const calc = germany(app, plugin, { getJson })
  return { state, app, calc, urls }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

test('station list: gauges with a W series, their zero above NHN', () => {
  const list = germany.readStations(fixture('germany-live-stations.json'))
  const cux = list.find(s => s.id === CUX)
  assert.deepStrictEqual(cux, { id: CUX, name: 'Cuxhaven Steubenhöft', water: 'Elbe', latitude: 53.867686, longitude: 8.717425, gaugeZero: -5.033, gaugeZeroUnit: 'm. ü. NHN' })
  assert.ok(!list.some(s => /^Gw-/.test(s.name)), 'groundwater wells have no W series')
})

test('NHN: W plus the gauge zero (Cuxhaven 553 cm, zero -5.033 m)', async () => {
  const { calc, app, urls } = setup()
  try {
    const v = byPath(await calc.calculator(CUXHAVEN))
    assert.deepStrictEqual(v, { 'environment.tide.heightObserved': 0.497, 'environment.tide.heightNow': 0.497 })
    assert.ok(app.statuses[0].startsWith('PEGELONLINE Cuxhaven Steubenhöft (Elbe) (NHN), height now from measurement'), app.statuses[0])
    assert.deepStrictEqual(urls, [
      'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?includeTimeseries=true',
      `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/${CUX}/W/measurements.json?start=PT2H`
    ])
    assert.strictEqual(calc.tideForecast, undefined)
  } finally {
    calc.stop()
  }
})

test('gauge zero: W as measured; Kiel on the Baltic', async () => {
  const { calc, state } = setup({ tides: { germanyDatum: 'gauge' } })
  state.position = KIEL
  try {
    const v = byPath(await calc.calculator(KIEL))
    assert.strictEqual(v['environment.tide.heightNow'], 5.02)
  } finally {
    calc.stop()
  }
  const nhn = setup()
  nhn.state.position = KIEL
  try {
    assert.strictEqual(byPath(await nhn.calc.calculator(KIEL))['environment.tide.heightNow'], 0.023)
  } finally {
    nhn.calc.stop()
  }
})

test('caches at the refresh interval; far from a gauge: quiet', async () => {
  const { calc, state, urls } = setup()
  try {
    await calc.calculator(CUXHAVEN)
    state.now = '2026-10-15T17:39:00Z'
    await calc.calculator(CUXHAVEN)
    assert.strictEqual(urls.length, 2)
    state.now = '2026-10-15T17:41:00Z'
    await calc.calculator(CUXHAVEN)
    assert.strictEqual(urls.length, 3)
  } finally {
    calc.stop()
  }
  const sea = setup()
  try {
    assert.strictEqual(await sea.calc.calculator({ latitude: 54.2, longitude: 7.5 }), undefined)
    assert.deepStrictEqual(sea.app.pluginErrors, [])
  } finally {
    sea.calc.stop()
  }
})

test('old measurements are not published', async () => {
  const { calc, state } = setup()
  try {
    state.now = '2026-10-15T18:40:00Z'
    assert.strictEqual(await calc.calculator(CUXHAVEN), undefined)
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
