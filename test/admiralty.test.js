/*
 * Offline tests for calcs/admiralty.js. Run with: node test/admiralty.test.js
 * The answers are built here in the format of the Admiralty UK Tidal API's documentation
 * (GeoJSON stations; TidalEvents with EventType, DateTime in UTC without a zone, Height); they are
 * not captured responses, as capturing needs an API key.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const admiralty = require('../calcs/admiralty')

const DOVER = { latitude: 51.11, longitude: 1.32 }
const KEY = 'test-key-123'

const STATIONS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [1.316667, 51.116667] }, properties: { Id: '0089', Name: 'DOVER', Country: 'England', ContinuousHeightsAvailable: true, Footnote: null } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.1, 50.8] }, properties: { Id: '0065', Name: 'PORTSMOUTH', Country: 'England', ContinuousHeightsAvailable: true, Footnote: null } }
  ]
}
const EVENTS = [
  { EventType: 'LowWater', DateTime: '2026-10-15T14:58:00', IsApproximateTime: false, Height: 1.21, IsApproximateHeight: false, Filtered: false, Date: '2026-10-15T00:00:00' },
  { EventType: 'HighWater', DateTime: '2026-10-15T20:41:00', IsApproximateTime: false, Height: 6.18, IsApproximateHeight: false, Filtered: false, Date: '2026-10-15T00:00:00' },
  { EventType: 'LowWater', DateTime: '2026-10-16T03:20:00', IsApproximateTime: false, Height: 1.05, IsApproximateHeight: false, Filtered: false, Date: '2026-10-16T00:00:00' },
  { EventType: 'HighWater', DateTime: '2026-10-16T09:02:00', IsApproximateTime: false, Height: 6.35, IsApproximateHeight: false, Filtered: false, Date: '2026-10-16T00:00:00' }
]

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T17:30:00Z', position: DOVER }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiralty-'))
  const app = {
    selfId: 'x', pluginErrors: [], statuses: [], messages: [], errors: [], debugs: [],
    debug (m) { this.debugs.push(m) }, error (m) { this.errors.push(m) },
    setPluginError (m) { this.pluginErrors.push(m) }, setPluginStatus (m) { this.statuses.push(m) },
    handleMessage (id, d) { this.messages.push(d) },
    getDataDirPath: () => dataDir,
    getSelfPath (p) {
      if (p === 'navigation.datetime') return { value: state.now }
      if (p === 'navigation.position') return state.position ? { value: state.position } : undefined
    }
  }
  const calls = []
  const getJson = (url, headers) => {
    calls.push({ url, headers })
    if (opts.fail) return Promise.reject(opts.fail)
    if (url.endsWith('/Stations')) return Promise.resolve(STATIONS)
    if (url.includes('/Stations/0089/TidalEvents?duration=7')) return Promise.resolve(opts.events || EVENTS)
    return Promise.reject(new Error('HTTP 404: {"statusCode":404,"message":"Resource not found"}'))
  }
  const tides = Object.assign({ admiralty: true, admiraltyApiKey: KEY }, opts.tides)
  const calc = admiralty(app, { id: 'tides-api', properties: { tides } }, { getJson })
  return { state, app, calc, calls }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

test('reads stations and tidal events; times are UTC', () => {
  assert.deepStrictEqual(admiralty.readStations(STATIONS)[0], { id: '0089', name: 'Dover', latitude: 51.116667, longitude: 1.316667 })
  assert.deepStrictEqual(admiralty.readEvents(EVENTS)[1], { time: new Date('2026-10-15T20:41:00Z'), value: 6.18, flag: 'high' })
})

test('next high and low at Dover above chart datum; the key goes in the header', async () => {
  const { calc, app, calls } = setup()
  try {
    const v = byPath(await calc.calculator(DOVER))
    assert.deepStrictEqual(v, {
      'environment.tide.heightHigh': 6.18,
      'environment.tide.timeHigh': '2026-10-15T20:41:00.000Z',
      'environment.tide.heightLow': 1.05,
      'environment.tide.timeLow': '2026-10-16T03:20:00.000Z'
    })
    assert.deepStrictEqual(calls.map(c => c.url), [
      'https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations',
      'https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations/0089/TidalEvents?duration=7'
    ])
    assert.ok(calls.every(c => c.headers['Ocp-Apim-Subscription-Key'] === KEY))
    assert.ok(!calls.some(c => c.url.includes(KEY)), 'never in the address')
    assert.ok(app.statuses[0].startsWith('Admiralty Dover (CD)'), app.statuses[0])
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'CD')
    assert.deepStrictEqual(f.extremes[0], { time: '2026-10-15T20:41:00.000Z', level: 6.18, high: true, low: false, label: 'High' })
  } finally {
    calc.stop()
  }
})

test('asks for highs and lows about once a day', async () => {
  // a week of events, high and low every 6 h 12.5 min from 2026-10-15T14:58
  const week = []
  for (let k = 0; k < 28; k++) {
    const t = new Date(Date.parse('2026-10-15T14:58:00Z') + k * 22350e3).toISOString().slice(0, 19)
    week.push({ EventType: k % 2 ? 'HighWater' : 'LowWater', DateTime: t, Height: k % 2 ? 6.2 : 1.1 })
  }
  const { calc, state, calls } = setup({ events: week })
  try {
    await calc.calculator(DOVER)
    state.now = '2026-10-16T11:00:00Z'
    await calc.calculator(DOVER)
    assert.strictEqual(calls.length, 2, 'more than 6 days left')
    state.now = '2026-10-16T20:00:00Z' // the week ends 2026-10-22T14:35: less than 6 days left
    await calc.calculator(DOVER)
    assert.strictEqual(calls.length, 3)
  } finally {
    calc.stop()
  }
})

test('no key: reported once, nothing asked', async () => {
  const { calc, app, calls } = setup({ tides: { admiraltyApiKey: ' ' } })
  try {
    assert.strictEqual(await calc.calculator(DOVER), undefined)
    await calc.calculator(DOVER)
    assert.strictEqual(calls.length, 0)
    assert.strictEqual(app.pluginErrors.filter(m => m.includes('no API key')).length, 1)
  } finally {
    calc.stop()
  }
})

test('a refused key says so', async () => {
  const { calc, app } = setup({ fail: new Error('HTTP 401: { "statusCode": 401, "message": "Access denied due to invalid subscription key." }') })
  try {
    await calc.calculator(DOVER)
    assert.ok(app.pluginErrors.some(m => m.includes('API key was refused')), app.pluginErrors.join('; '))
    assert.ok(!app.pluginErrors.some(m => m.includes(KEY)))
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
