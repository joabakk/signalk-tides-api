/*
 * Offline tests for calcs/ioc.js. Run with: node test/ioc.test.js
 * Fixtures are real IOC SLSMF responses captured 2026-10-19T13:25Z: the station list rows within
 * 150 km of Viker and Scoresbysund (and the Reykjavik row, silent since 2020), and the last 3 hours
 * at Viker (float gauge) and Ittoqqortoormiit/Scoresbysund (pressure gauge).
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ioc = require('../calcs/ioc')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const FREDRIKSTAD = { latitude: 59.10, longitude: 10.95 }
const SCORESBYSUND = { latitude: 70.48, longitude: -21.95 }
const REYKJAVIK = { latitude: 64.15, longitude: -21.94 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function answer (url) {
  const q = new URL(url).searchParams
  if (q.get('query') === 'stationlist') return fixture('ioc-live-stations.json')
  if (q.get('code') === 'vike') return fixture('ioc-live-viker.json')
  if (q.get('code') === 'scor') return fixture('ioc-live-scoresbysund.json')
  return [{ error: 'Invalid code' }]
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-19T13:25:04Z', position: opts.position || FREDRIKSTAD }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ioc-'))
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
    return Promise.resolve((opts.answer || answer)(url))
  }
  const plugin = opts.plugin || { id: 'tides-api', properties: { tides: { ioc: true } } }
  const calc = ioc(app, plugin, { getJson })
  return { state, app, calc, urls }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

test('station list: water level sensors that reported in the last two days', () => {
  const rows = fixture('ioc-live-stations.json')
  rows.push({ Code: 'vike', Location: 'Viker', Lat: 59.036046, Lon: 10.949769, sensor: 'bat', lasttime: '2026-10-19 13:20:00.000' })
  rows.push({ Code: 'volt', Location: 'Battery only', Lat: 59.1, Lon: 10.9, sensor: 'bat', lasttime: '2026-10-19 13:20:00.000' })
  const list = ioc.readStations(rows, Date.parse('2026-10-19T13:25:04Z'))
  assert.deepStrictEqual(list.find(s => s.id === 'vike'), { id: 'vike', name: 'Viker', latitude: 59.036046, longitude: 10.949769, sensors: ['flt'] })
  assert.ok(!list.some(s => s.id === 'volt'), 'battery voltage is not a water level')
  assert.ok(!list.some(s => s.id === 'reyk'), 'silent since 2020')
})

test('levels: the best water level sensor, UTC times', () => {
  const mixed = [
    { slevel: 12.6, stime: '2026-10-19 13:20:00', sensor: 'bat' },
    { slevel: 0.40, stime: '2026-10-19 13:20:00', sensor: 'flt' },
    { slevel: 0.41, stime: '2026-10-19 13:20:00', sensor: 'rad' },
    { slevel: 1013, stime: '2026-10-19 13:20:00', sensor: 'atm' }
  ]
  assert.deepStrictEqual(ioc.readLevels(mixed), [{ time: new Date('2026-10-19T13:20:00Z'), value: 0.41 }])
})

test('Viker: the latest level, relative to the gauge zero', async () => {
  const { calc, app, urls } = setup()
  try {
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.deepStrictEqual(v, { 'environment.tide.heightObserved': 0.384, 'environment.tide.heightNow': 0.384 }) // 13:20
    assert.strictEqual(urls[1], 'https://www.ioc-sealevelmonitoring.org/service.php?query=data&code=vike&timestart=2026-10-19T10:25:04&timestop=2026-10-19T13:25:04&format=json')
    assert.ok(app.statuses[0].startsWith('IOC Viker (gauge zero, not referenced), height now from measurement'), app.statuses[0])
    assert.strictEqual(calc.tideForecast, undefined)
  } finally {
    calc.stop()
  }
})

test('Scoresbysund (pressure gauge, every minute); Reykjavik silent: nothing', async () => {
  const sc = setup({ position: SCORESBYSUND })
  try {
    assert.strictEqual(byPath(await sc.calc.calculator(SCORESBYSUND))['environment.tide.heightNow'], 0.439)
  } finally {
    sc.calc.stop()
  }
  const rk = setup({ position: REYKJAVIK })
  try {
    assert.strictEqual(await rk.calc.calculator(REYKJAVIK), undefined)
    assert.deepStrictEqual(rk.app.pluginErrors, [])
    assert.strictEqual(rk.urls.length, 1, 'only the station list')
  } finally {
    rk.calc.stop()
  }
})

test('quiet while a station-based provider publishes; IOC errors are reported', async () => {
  const plugin = { id: 'tides-api', properties: { tides: { ioc: true } }, tideDeltasAt: { kartverket: Date.now() } }
  const quiet = setup({ plugin })
  try {
    assert.strictEqual(await quiet.calc.calculator(FREDRIKSTAD), undefined)
  } finally {
    quiet.calc.stop()
  }
  const bad = setup({ answer: url => new URL(url).searchParams.get('query') === 'data' ? [{ error: 'Invalid date provided' }] : answer(url) })
  try {
    await bad.calc.calculator(FREDRIKSTAD)
    assert.ok(bad.app.pluginErrors.some(m => m.includes('Invalid date provided')), bad.app.pluginErrors.join('; '))
  } finally {
    bad.calc.stop()
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
