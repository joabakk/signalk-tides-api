/*
 * Offline tests for calcs/chs.js. Run with: node test/chs.test.js
 * Answers are generated here in the IWLS format (field names as used by working clients:
 * id, code, officialName, latitude, longitude, timeSeries[].code; eventDate, value).
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const chs = require('../calcs/chs')

const VICTORIA = { latitude: 48.42, longitude: -123.37 }
const TORONTO = { latitude: 43.64, longitude: -79.38 }
const HALIFAX = { latitude: 44.65, longitude: -63.57 }

const STATIONS = [
  { id: '5cebf1de3d0f4a073c4bbd1e', code: '07120', officialName: 'Victoria Harbour', latitude: 48.424666, longitude: -123.370782,
    timeSeries: [{ code: 'wlo' }, { code: 'wlp' }, { code: 'wlp-hilo' }, { code: 'wlf' }] },
  { id: '5cebf1de3d0f4a073c4bbd2f', code: '07795', officialName: 'Point Atkinson', latitude: 49.337, longitude: -123.253,
    timeSeries: [{ code: 'wlo' }, { code: 'wlp' }, { code: 'wlp-hilo' }] },
  { id: '5cebf1de3d0f4a073c4bb94e', code: '13320', officialName: 'Toronto', latitude: 43.64, longitude: -79.38,
    timeSeries: [{ code: 'wlo' }, { code: 'wlf' }] }
]

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Semidiurnal tide of ±1.2 m around 1.9 m (chart datum); measured 0.15 m above the prediction.
const H0 = Date.UTC(2026, 9, 15, 6, 0)
const PERIOD = 12.42 * 3600e3
const tide = t => 1.9 + 1.2 * Math.cos(2 * Math.PI * (t - H0) / PERIOD)

function answer (url, overrides) {
  const u = new URL(url)
  if (u.pathname.endsWith('/stations')) return STATIONS
  const code = u.searchParams.get('time-series-code')
  if (overrides && overrides[code] !== undefined) return overrides[code]
  const from = Date.parse(u.searchParams.get('from'))
  const to = Date.parse(u.searchParams.get('to'))
  const rows = []
  const row = (t, v) => rows.push({ eventDate: new Date(t).toISOString().replace('.000', ''), value: Math.round(v * 1000) / 1000, qcFlagCode: '1', timeSeriesId: 'x' })
  if (code === 'wlp-hilo') {
    for (let k = -2; k < 20; k++) {
      const t = H0 + k * PERIOD / 2
      if (t >= from && t <= to) row(t, tide(t))
    }
  } else {
    const step = code === 'wlo' ? 60e3 : 15 * 60e3
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) row(t, tide(t) + (code === 'wlo' ? 0.15 : code === 'wlf' ? 0.1 : 0))
  }
  return rows
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T10:07:00Z', position: VICTORIA }
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'chs-'))
  const app = {
    selfId: 'x', pluginErrors: [], statuses: [], messages: [], debugs: [],
    debug (m) { this.debugs.push(m) }, error () {},
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
    const a = answer(url, opts.overrides)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ chs: true }, opts.tides) } }
  const calc = chs(app, plugin, { getJson })
  const of = code => urls.filter(u => u.searchParams.get('time-series-code') === code)
  return { state, app, calc, urls, of, dataDir }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

test('publishes highs and lows, predicted, measured and forecast levels', async () => {
  const { calc, app } = setup()
  try {
    const v = byPath(await calc.calculator(VICTORIA))
    // the next low after 10:07 is at 06:00 + 6.21 h = 12:12:36, then a high at 18:25:12
    assert.strictEqual(v['environment.tide.timeLow'], '2026-10-15T12:12:36.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], 0.7)
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-15T18:25:12.000Z')
    assert.strictEqual(v['environment.tide.heightHigh'], 3.1)
    const now = Date.parse('2026-10-15T10:07:00Z')
    assert.ok(near(v['environment.tide.heightPredicted'], tide(now), 0.01))
    assert.ok(near(v['environment.tide.heightObserved'], tide(now) + 0.15, 0.002))
    assert.ok(near(v['environment.tide.heightForecast'], tide(now) + 0.1, 0.01))
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightObserved'])
    assert.ok(near(v['environment.tide.weatherEffect'], 0.15, 0.01))
    assert.ok(app.statuses[0].includes('CHS Victoria Harbour (CD), height now from measurement'))
    assert.ok(app.statuses[0].includes('non-commercial licence'))
  } finally {
    calc.stop()
  }
})

test('sends the expected requests, one station list', async () => {
  const { calc, urls } = setup()
  try {
    await calc.calculator(VICTORIA)
    assert.deepStrictEqual(urls.map(u => u.pathname.replace('/api/v1', '') + (u.searchParams.get('time-series-code') ? `?${u.searchParams.get('time-series-code')}` : '')), [
      '/stations',
      '/stations/5cebf1de3d0f4a073c4bbd1e/data?wlp-hilo',
      '/stations/5cebf1de3d0f4a073c4bbd1e/data?wlp',
      '/stations/5cebf1de3d0f4a073c4bbd1e/data?wlo',
      '/stations/5cebf1de3d0f4a073c4bbd1e/data?wlf'
    ])
    const hilo = urls[1].searchParams
    assert.strictEqual(hilo.get('from'), '2026-10-15T09:07:00Z')
    assert.strictEqual(hilo.get('to'), '2026-10-22T10:07:00Z')
    assert.strictEqual(urls[0].origin, 'https://api-iwls.dfo-mpo.gc.ca')
  } finally {
    calc.stop()
  }
})

test('caches: measured every 10 min, forecast hourly, predictions when they run out', async () => {
  const { calc, state, of, urls } = setup()
  try {
    await calc.calculator(VICTORIA)
    state.now = '2026-10-15T10:16:00Z'
    await calc.calculator(VICTORIA)
    assert.strictEqual(urls.length, 5)
    state.now = '2026-10-15T10:17:00Z'
    await calc.calculator(VICTORIA)
    assert.strictEqual(of('wlo').length, 2)
    assert.strictEqual(of('wlf').length, 1)
    state.now = '2026-10-15T11:07:00Z'
    await calc.calculator(VICTORIA)
    assert.strictEqual(of('wlf').length, 2)
    state.now = '2026-10-17T04:08:00Z' // the 2-day prediction ends 10-17T10:07: asked again 6 h before
    await calc.calculator(VICTORIA)
    assert.strictEqual(of('wlp').length, 2)
    assert.strictEqual(of('wlp-hilo').length, 1)
    assert.strictEqual(urls.filter(u => u.pathname.endsWith('/stations')).length, 1)
  } finally {
    calc.stop()
  }
})

test('station choice: needs predictions, within the distance limit', async () => {
  const toronto = setup()
  toronto.state.position = TORONTO
  try {
    assert.strictEqual(await toronto.calc.calculator(TORONTO), undefined, 'Toronto has no predictions; others are too far')
    assert.deepStrictEqual(toronto.app.pluginErrors, [])
  } finally {
    toronto.calc.stop()
  }
  const vancouver = setup()
  try {
    await vancouver.calc.calculator({ latitude: 49.30, longitude: -123.20 })
    assert.ok(vancouver.urls[1].pathname.includes('5cebf1de3d0f4a073c4bbd2f'), 'Point Atkinson')
    assert.strictEqual(vancouver.of('wlf').length, 0, 'no forecast series there')
  } finally {
    vancouver.calc.stop()
  }
  const far = setup()
  try {
    assert.strictEqual(await far.calc.calculator(HALIFAX), undefined)
  } finally {
    far.calc.stop()
  }
})

test('a missing series (404) waits a whole interval; the rest keeps working', async () => {
  const { calc, app, state, of } = setup({ overrides: { wlf: new Error('HTTP 404: Not Found') } })
  try {
    const v = byPath(await calc.calculator(VICTORIA))
    assert.ok(v['environment.tide.heightNow'] > 0)
    assert.strictEqual(v['environment.tide.heightForecast'], undefined)
    assert.ok(app.pluginErrors.some(m => m.includes('no wlf data')))
    state.now = '2026-10-15T10:30:00Z'
    await calc.calculator(VICTORIA)
    assert.strictEqual(of('wlf').length, 1)
  } finally {
    calc.stop()
  }
})

test('the station list is kept in a file', async () => {
  const first = setup()
  await first.calc.calculator(VICTORIA)
  first.calc.stop()
  await new Promise(resolve => setTimeout(resolve, 30))
  const second = setup({ dataDir: first.dataDir })
  try {
    await second.calc.calculator(VICTORIA)
    assert.strictEqual(second.urls.filter(u => u.pathname.endsWith('/stations')).length, 0)
  } finally {
    second.calc.stop()
  }
})

test('tides resource', async () => {
  const { calc } = setup()
  try {
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'CD')
    assert.deepStrictEqual(f.station, { id: 'chs/07120', name: 'Victoria Harbour', latitude: 48.424666, longitude: -123.370782 })
    assert.deepStrictEqual(f.extremes[0], { time: '2026-10-15T12:12:36.000Z', level: 0.7, high: false, low: true, label: 'Low' })
    assert.ok(f.extremes.length >= 12)
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
