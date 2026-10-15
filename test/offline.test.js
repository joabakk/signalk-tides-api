/*
 * Offline tests for calcs/offline.js. Run with: node test/offline.test.js
 * Uses a fake Neaps for exact checks, and the real Neaps database when it is installed
 * (it is an optional dependency).
 */
const assert = require('assert')
const offline = require('../calcs/offline')

const COPENHAGEN = { latitude: 55.69, longitude: 12.60 }
const FAR = { latitude: 59.21, longitude: 10.95 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function mockApp (state) {
  return {
    selfId: 'urn:mrn:imo:mmsi:000000000',
    errors: [],
    pluginErrors: [],
    statuses: [],
    messages: [],
    debugs: [],
    debug (m) { this.debugs.push(m) },
    error (m) { this.errors.push(m) },
    setPluginError (m) { this.pluginErrors.push(m) },
    setPluginStatus (m) { this.statuses.push(m) },
    handleMessage (id, delta) { this.messages.push(delta) },
    getSelfPath (p) {
      if (p === 'navigation.datetime') return state.now ? { value: state.now } : undefined
      if (p === 'navigation.position') return state.position ? { value: state.position } : undefined
      return undefined
    }
  }
}

// A one-station Neaps: 12 h tide of ±0.5 m around MSL, LAT 0.6 m below MSL.
function fakeNeaps (calls) {
  const station = (position) => {
    const distance = Math.hypot(position.latitude - 55.70, (position.longitude - 12.60) * 0.56) * 111
    const level = (t, datum) => 0.5 * Math.cos(2 * Math.PI * (t - Date.UTC(2026, 9, 15, 0)) / (12 * 3600e3)) + (datum === 'LAT' ? 0.6 : 0)
    return {
      id: 'ticon/kobenhavn-kob-dnk-cmems',
      name: 'Kobenhavn',
      latitude: 55.70,
      longitude: 12.60,
      distance,
      defaultDatum: 'MSL',
      datums: { MSL: 0, LAT: -0.6 },
      source: { name: 'TICON-4' },
      license: { type: 'cc-by-nc-4.0', commercial_use: false },
      getExtremesPrediction ({ start, end, datum }) {
        calls.push(['extremes', datum])
        const extremes = []
        for (let t = Date.UTC(2026, 9, 15, 0); t <= end.getTime(); t += 6 * 3600e3) {
          if (t < start.getTime()) continue
          const high = ((t - Date.UTC(2026, 9, 15, 0)) / (6 * 3600e3)) % 2 === 0
          extremes.push({ time: new Date(t), level: level(t, datum), high, low: !high, label: high ? 'High' : 'Low' })
        }
        return { datum: datum || 'MSL', extremes }
      },
      getTimelinePrediction ({ start, end, timeFidelity, datum }) {
        calls.push(['timeline', datum])
        const timeline = []
        for (let t = start.getTime(); t <= end.getTime(); t += timeFidelity * 1000) timeline.push({ time: new Date(t), level: level(t, datum) })
        return { datum: datum || 'MSL', timeline }
      }
    }
  }
  return { nearestStation: position => station(position) }
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T14:55:00Z', position: COPENHAGEN }
  const app = mockApp(state)
  const calls = []
  let loads = 0
  const loadNeaps = opts.loadNeaps || (() => { loads++; return Promise.resolve(fakeNeaps(calls)) })
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ offline: true }, opts.tides) } }
  const calc = offline(app, plugin, { loadNeaps })
  return { state, app, calc, calls, loads: () => loads }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

test('publishes the astronomical tide from the nearest station', async () => {
  const { calc, app } = setup()
  try {
    assert.strictEqual(calc.optionKey, 'offline')
    const v = byPath(await calc.calculator(COPENHAGEN))
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-16T00:00:00.000Z')
    assert.strictEqual(v['environment.tide.heightHigh'], 0.5)
    assert.strictEqual(v['environment.tide.timeLow'], '2026-10-15T18:00:00.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], -0.5)
    assert.ok(typeof v['environment.tide.heightPredicted'] === 'number')
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightPredicted'])
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.ok(app.statuses[0].includes('Offline Kobenhavn (MSL)'))
    assert.ok(app.statuses[0].includes('TICON-4 via Neaps, cc-by-nc-4.0, no commercial use'))
  } finally {
    calc.stop()
  }
})

test('chosen datum, with a fallback to the station datum', async () => {
  const lat = setup({ tides: { offlineDatum: 'LAT' } })
  try {
    const v = byPath(await lat.calc.calculator(COPENHAGEN))
    assert.strictEqual(v['environment.tide.heightLow'], 0.1)
    assert.ok(lat.app.statuses[0].includes('(LAT)'))
  } finally {
    lat.calc.stop()
  }
  const mllw = setup({ tides: { offlineDatum: 'MLLW' } }) // the fake station has no MLLW
  try {
    await mllw.calc.calculator(COPENHAGEN)
    assert.ok(mllw.app.statuses[0].includes('(MSL)'))
    assert.deepStrictEqual(mllw.app.pluginErrors, [])
  } finally {
    mllw.calc.stop()
  }
})

test('beyond the distance limit nothing is published and nothing reported', async () => {
  const { calc, app } = setup()
  try {
    assert.strictEqual(await calc.calculator(FAR), undefined)
    assert.deepStrictEqual(app.pluginErrors, [])
  } finally {
    calc.stop()
  }
  const wide = setup({ tides: { offlineMaxDistanceKm: 1000 } })
  try {
    assert.ok(await wide.calc.calculator(FAR))
  } finally {
    wide.calc.stop()
  }
})

test('computes again only after 6 h, a move over 1 km or a datum change', async () => {
  const { calc, calls, state, loads } = setup()
  const computations = () => calls.filter(c => c[0] === 'extremes').length
  try {
    await calc.calculator(COPENHAGEN)
    state.now = '2026-10-15T18:00:00Z'
    await calc.calculator({ latitude: 55.692, longitude: 12.601 }) // ~250 m
    assert.strictEqual(computations(), 1)
    state.now = '2026-10-15T20:56:00Z'
    await calc.calculator(COPENHAGEN)
    assert.strictEqual(computations(), 2, 'after 6 h')
    await calc.calculator({ latitude: 55.71, longitude: 12.60 }) // ~2 km
    assert.strictEqual(computations(), 3, 'after moving')
    assert.strictEqual(loads(), 1, 'database loaded once')
  } finally {
    calc.stop()
  }
})

test('without Neaps installed it says how to install it, and retries with back-off', async () => {
  let attempts = 0
  const { calc, app, state } = setup({ loadNeaps: () => { attempts++; return Promise.reject(new Error("Cannot find package 'neaps'")) } })
  try {
    assert.strictEqual(await calc.calculator(COPENHAGEN), undefined)
    assert.ok(app.pluginErrors.some(m => m.includes('npm install neaps')))
    state.now = '2026-10-15T14:58:00Z'
    await calc.calculator(COPENHAGEN)
    assert.strictEqual(attempts, 1)
  } finally {
    calc.stop()
  }
})

test('tides resource', async () => {
  const { calc } = setup()
  try {
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'MSL')
    assert.deepStrictEqual(f.station, { id: 'offline/ticon/kobenhavn-kob-dnk-cmems', name: 'Kobenhavn', latitude: 55.70, longitude: 12.60 })
    assert.deepStrictEqual(f.extremes[0], { time: '2026-10-15T18:00:00.000Z', level: -0.5, high: false, low: true, label: 'Low' })
  } finally {
    calc.stop()
  }
})

test('the real Neaps database (if installed): Copenhagen', async () => {
  // neaps is an ES module only, so require.resolve can't find it: try importing it
  const realNeaps = await import('neaps').then(() => true, () => false)
  if (!realNeaps) {
    console.log('  (skipped: neaps is not installed)')
    return
  }
  const state = { now: '2026-10-15T14:55:00Z', position: COPENHAGEN }
  const app = mockApp(state)
  const calc = offline(app, { id: 'tides-api', properties: { tides: { offline: true } } })
  try {
    const v = byPath(await calc.calculator(COPENHAGEN))
    assert.ok(app.statuses[0].includes('Kobenhavn'), app.statuses[0])
    assert.ok(v['environment.tide.timeHigh'] > '2026-10-15T14:55:00.000Z')
    assert.ok(Math.abs(v['environment.tide.heightNow']) < 0.5, 'small Baltic tide')
    const f = await calc.tideForecast()
    assert.ok(f.extremes.length >= 20, '7 days of highs and lows')
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
