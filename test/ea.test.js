/*
 * Offline tests for calcs/ea.js. Run with: node test/ea.test.js
 * Fixtures are real Environment Agency responses captured 2026-10-15T17:30Z: the tide gauge list
 * and the latest 12 readings at Dover (local datum, E71624) and Newlyn (mAOD, E72239).
 * Data: Environment Agency, Open Government Licence v3.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ea = require('../calcs/ea')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const DOVER = { latitude: 51.11, longitude: 1.33 }
const NEWLYN = { latitude: 50.10, longitude: -5.54 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function answer (url) {
  if (url.endsWith('/id/stations?type=TideGauge')) return fixture('ea-live-gauges.json')
  if (url.includes('/id/stations/E71624/readings')) return fixture('ea-live-dover-readings.json')
  if (url.includes('/id/stations/E72239/readings')) return fixture('ea-live-newlyn-readings.json')
  return new Error('HTTP 404: Not Found')
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T17:30:47Z', position: opts.position || DOVER }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-'))
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
    const a = answer(url)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ ea: true }, opts.tides) } }
  const calc = ea(app, plugin, { getJson })
  return { state, app, calc, urls }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

test('gauge list: one entry per datum, the mm gauges left out', () => {
  const list = ea.readGauges(fixture('ea-live-gauges.json'))
  assert.strictEqual(list.length, 86)
  assert.deepStrictEqual(list.filter(g => g.name === 'Dover').map(g => [g.id, g.datum]).sort(), [['E71624', 'local'], ['E71639', 'AOD']])
  assert.ok(!list.some(g => g.id === 'E72825' || g.id === 'E72623'), 'Newport and Avonmouth Portbury in mm')
})

test('local datum at Dover: the latest 15-minute mean', async () => {
  const { calc, app, urls } = setup({ tides: { eaDatum: 'local' } })
  try {
    const v = byPath(await calc.calculator(DOVER))
    assert.deepStrictEqual(v, { 'environment.tide.heightObserved': 4.368, 'environment.tide.heightNow': 4.368 }) // 16:45Z
    assert.strictEqual(urls[1], 'https://environment.data.gov.uk/flood-monitoring/id/stations/E71624/readings?_sorted&_limit=12')
    assert.ok(app.statuses[0].startsWith('Environment Agency Dover (local datum), height now from measurement'), app.statuses[0])
    assert.strictEqual(calc.tideForecast, undefined)
  } finally {
    calc.stop()
  }
})

test('mAOD at Newlyn; mAOD at Dover asks the mAOD gauge', async () => {
  const newlyn = setup({ position: NEWLYN })
  try {
    assert.strictEqual(byPath(await newlyn.calc.calculator(NEWLYN))['environment.tide.heightNow'], 0.758)
    assert.ok(newlyn.app.statuses[0].includes('Newlyn (AOD)'))
  } finally {
    newlyn.calc.stop()
  }
  const dover = setup()
  try {
    await dover.calc.calculator(DOVER)
    assert.ok(dover.urls[1].includes('/id/stations/E71639/readings'), dover.urls[1])
    assert.ok(dover.app.pluginErrors.some(m => m.includes('no readings at Dover')), 'no capture for E71639')
  } finally {
    dover.calc.stop()
  }
})

test('every 15 minutes; far from a gauge: quiet; old readings dropped', async () => {
  const { calc, state, urls } = setup({ tides: { eaDatum: 'local' } })
  try {
    await calc.calculator(DOVER)
    state.now = '2026-10-15T17:44:00Z'
    await calc.calculator(DOVER)
    assert.strictEqual(urls.length, 2)
    state.now = '2026-10-15T17:46:00Z'
    await calc.calculator(DOVER)
    assert.strictEqual(urls.length, 3)
    state.now = '2026-10-15T18:50:00Z' // 2 h 5 min after the latest reading
    assert.strictEqual(byPath(await calc.calculator(DOVER))['environment.tide.heightNow'], undefined)
  } finally {
    calc.stop()
  }
  const sea = setup()
  try {
    assert.strictEqual(await sea.calc.calculator({ latitude: 50.5, longitude: -2.0 }), undefined)
    assert.deepStrictEqual(sea.app.pluginErrors, [])
  } finally {
    sea.calc.stop()
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
