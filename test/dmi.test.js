/*
 * Offline tests for calcs/dmi.js. Run with: node test/dmi.test.js
 *
 * The fixtures test/fixtures/dmi-*.json are real DMI oceanObs responses for Esbjerg
 * (2026-09-14), recorded by open-tides and trimmed. Data: DMI, CC BY 4.0.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const dmi = require('../calcs/dmi')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const ESBJERG = { latitude: 55.46, longitude: 8.44 }
const COPENHAGEN = { latitude: 55.69, longitude: 12.60 }
const AAPPILATTOQ = { latitude: 60.15, longitude: -44.29 } // prediction station without a gauge
const FREDRIKSTAD = { latitude: 59.21, longitude: 10.95 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function mockApp (state) {
  return {
    selfId: 'urn:mrn:imo:mmsi:000000000',
    dataDir: state.dataDir,
    errors: [],
    pluginErrors: [],
    statuses: [],
    messages: [],
    debug () {},
    error (m) { this.errors.push(m) },
    setPluginError (m) { this.pluginErrors.push(m) },
    setPluginStatus (m) { this.statuses.push(m) },
    handleMessage (id, delta) { this.messages.push(delta) },
    getDataDirPath () { return state.dataDir },
    getSelfPath (p) {
      if (p === 'navigation.datetime') return state.now ? { value: state.now } : undefined
      if (p === 'navigation.position') return state.position ? { value: state.position } : undefined
      return undefined
    }
  }
}

// Answers by collection (and prediction type) from the fixtures; records every URL.
function mockFetch (overrides) {
  const calls = []
  const fn = url => {
    const u = new URL(url)
    calls.push(u)
    const collection = u.pathname.split('/').slice(-2)[0]
    const key = collection === 'tidewater' ? `tidewater:${u.searchParams.get('predictionType')}` : collection
    const o = overrides && overrides[key]
    if (o instanceof Error) return Promise.reject(o)
    if (o) return Promise.resolve(o)
    const files = {
      tidewaterstation: 'dmi-tidewaterstations.json',
      station: 'dmi-stations.json',
      'tidewater:minimum_maximum': 'dmi-extremes.json',
      'tidewater:10minutes': 'dmi-curve.json',
      observation: 'dmi-observation.json'
    }
    return Promise.resolve(fixture(files[key]))
  }
  fn.calls = calls
  fn.of = key => calls.filter(u => {
    const collection = u.pathname.split('/').slice(-2)[0]
    return (collection === 'tidewater' ? `tidewater:${u.searchParams.get('predictionType')}` : collection) === key
  })
  return fn
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-09-14T13:35:00Z', position: ESBJERG, dataDir: opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-')) }
  const app = mockApp(state)
  const fetchJson = mockFetch(opts.overrides)
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ dmi: true }, opts.tides) } }
  const calc = dmi(app, plugin, { fetchJson, republishInterval: opts.republishInterval })
  return { state, app, fetchJson, plugin, calc }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('publishes high, low, predicted and measured levels for the nearest station', async () => {
  const { calc, fetchJson, app } = setup()
  try {
    assert.strictEqual(calc.optionKey, 'dmi')
    assert.strictEqual(calc.group, 'tides')
    const v = byPath(await calc.calculator(ESBJERG))
    assert.strictEqual(v['environment.tide.heightHigh'], 0.88)
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-09-14T15:38:00.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], -0.968)
    assert.strictEqual(v['environment.tide.timeLow'], '2026-09-14T21:47:00.000Z')
    assert.strictEqual(v['environment.tide.heightPredicted'], 0.486) // between 45.9 and 51.3 cm
    assert.strictEqual(v['environment.tide.heightObserved'], 0.53) // 13:30 measurement
    assert.strictEqual(v['environment.tide.heightNow'], 0.53)
    assert.strictEqual(v['environment.tide.weatherEffect'], 0.071) // 53.0 - 45.9 cm at 13:30
    assert.ok(app.statuses.some(s => s.includes('Esbjerg Havn') && s.includes('DMI')))
    assert.deepStrictEqual(app.pluginErrors, [])
    assert.strictEqual(app.messages.filter(m => m.updates[0].meta).length, 1, 'units sent once')
  } finally {
    calc.stop()
  }
})

test('sends the expected requests', async () => {
  const { calc, fetchJson } = setup()
  try {
    await calc.calculator(ESBJERG)
    const base = dmi.DEFAULT_API_URL
    assert.deepStrictEqual(fetchJson.calls.map(u => u.origin + u.pathname), [
      `${base}/tidewaterstation/items`,
      `${base}/station/items`,
      `${base}/tidewater/items`,
      `${base}/tidewater/items`,
      `${base}/observation/items`
    ])
    assert.ok(fetchJson.calls.every(u => u.searchParams.get('limit') === '10000'))
    const ext = fetchJson.of('tidewater:minimum_maximum')[0].searchParams
    assert.strictEqual(ext.get('stationId'), '25149')
    assert.strictEqual(ext.get('datetime'), '2026-09-14T12:35:00Z/2026-09-21T13:35:00Z')
    const curve = fetchJson.of('tidewater:10minutes')[0].searchParams
    assert.strictEqual(curve.get('datetime'), '2026-09-14T12:35:00Z/2026-09-16T13:35:00Z')
    const obs = fetchJson.of('observation')[0].searchParams
    assert.strictEqual(obs.get('stationId'), '25149')
    assert.strictEqual(obs.get('parameterId'), 'sealev_dvr')
    assert.strictEqual(obs.get('period'), 'latest-hour')
  } finally {
    calc.stop()
  }
})

test('caches: measurements every 10 min, predictions only when they run out', async () => {
  const { calc, fetchJson, state } = setup()
  try {
    await calc.calculator(ESBJERG)
    assert.strictEqual(fetchJson.calls.length, 5)
    state.now = '2026-09-14T13:44:00Z'
    await calc.calculator(ESBJERG)
    assert.strictEqual(fetchJson.calls.length, 5, 'nothing within 10 min')
    state.now = '2026-09-14T13:46:00Z'
    await calc.calculator(ESBJERG)
    assert.deepStrictEqual(fetchJson.calls.slice(5).map(u => u.pathname.split('/').slice(-2)[0]), ['observation'])
    // the 10-minute prediction in the fixture ends 2026-09-15T12:00: asked again 6 h before
    state.now = '2026-09-15T06:01:00Z'
    await calc.calculator(ESBJERG)
    assert.strictEqual(fetchJson.of('tidewater:10minutes').length, 2)
    assert.strictEqual(fetchJson.of('tidewater:minimum_maximum').length, 1)
    // the highs and lows end 2026-09-20T19:49: asked again a day before
    state.now = '2026-09-19T20:00:00Z'
    await calc.calculator(ESBJERG)
    assert.strictEqual(fetchJson.of('tidewater:minimum_maximum').length, 2)
    assert.strictEqual(fetchJson.of('tidewaterstation').length, 1, 'station list kept')
  } finally {
    calc.stop()
  }
})

test('the station list is kept in a file for a month', async () => {
  const first = setup()
  try {
    await first.calc.calculator(ESBJERG)
  } finally {
    first.calc.stop()
  }
  await wait(50) // the file is written asynchronously
  assert.ok(fs.existsSync(path.join(first.state.dataDir, 'dmi-stations.json')))
  const second = setup({ dataDir: first.state.dataDir })
  try {
    await second.calc.calculator(ESBJERG)
    assert.strictEqual(second.fetchJson.of('tidewaterstation').length, 0)
    assert.strictEqual(second.fetchJson.of('station').length, 0)
  } finally {
    second.calc.stop()
  }
  const later = setup({ dataDir: first.state.dataDir })
  later.state.now = '2026-10-15T13:35:00Z'
  try {
    await later.calc.calculator(ESBJERG)
    assert.strictEqual(later.fetchJson.of('tidewaterstation').length, 1, 'fetched again after a month')
  } finally {
    later.calc.stop()
  }
})

test('heights above lowest astronomical tide when chosen', async () => {
  const { calc } = setup({ tides: { dmiDatum: 'LAT' } }) // Esbjerg LAT is 120.8 cm below DVR90
  try {
    const v = byPath(await calc.calculator(ESBJERG))
    assert.strictEqual(v['environment.tide.heightHigh'], 2.088)
    assert.strictEqual(v['environment.tide.heightLow'], 0.24)
    assert.strictEqual(v['environment.tide.heightNow'], 1.738)
    assert.strictEqual(v['environment.tide.weatherEffect'], 0.071, 'a difference, not shifted')
  } finally {
    calc.stop()
  }
})

test('picks the nearest station and its gauge', async () => {
  const { calc, fetchJson } = setup()
  try {
    await calc.calculator(COPENHAGEN)
    assert.strictEqual(fetchJson.of('tidewater:minimum_maximum')[0].searchParams.get('stationId'), '30336')
    assert.strictEqual(fetchJson.of('observation')[0].searchParams.get('stationId'), '30336')
  } finally {
    calc.stop()
  }
})

test('a station without a gauge uses the prediction for height now', async () => {
  const { calc, fetchJson } = setup()
  try {
    const v = byPath(await calc.calculator(AAPPILATTOQ))
    assert.strictEqual(fetchJson.of('observation').length, 0)
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightPredicted'])
  } finally {
    calc.stop()
  }
})

test('retired gauges are not used', async () => {
  const gauges = fixture('dmi-stations.json')
  gauges.features.forEach(f => {
    if (f.properties.stationId === '25149') f.properties.validTo = '2026-01-01T00:00:00Z'
  })
  const { calc, fetchJson } = setup({ overrides: { station: gauges } })
  try {
    const v = byPath(await calc.calculator(ESBJERG))
    assert.strictEqual(fetchJson.of('observation').length, 0)
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightPredicted'])
  } finally {
    calc.stop()
  }
})

test('outside DMI waters: no predictions asked, nothing published, no error', async () => {
  const { calc, fetchJson, app } = setup()
  try {
    assert.strictEqual(await calc.calculator(FREDRIKSTAD), undefined)
    assert.deepStrictEqual(fetchJson.calls.map(u => u.pathname.split('/').slice(-2)[0]), ['tidewaterstation', 'station'])
    assert.deepStrictEqual(app.pluginErrors, [])
  } finally {
    calc.stop()
  }
  const wide = setup({ tides: { dmiMaxDistanceKm: 500 } })
  try {
    await wide.calc.calculator(FREDRIKSTAD)
    assert.strictEqual(wide.fetchJson.of('tidewater:minimum_maximum').length, 1, 'within a wider limit')
  } finally {
    wide.calc.stop()
  }
})

test('never rejects: errors are reported and retries back off', async () => {
  const { calc, fetchJson, app, state } = setup({ overrides: { tidewaterstation: new Error('ETIMEDOUT') } })
  try {
    assert.strictEqual(await calc.calculator(ESBJERG), undefined)
    assert.ok(app.pluginErrors.some(m => m.includes('ETIMEDOUT')))
    state.now = '2026-09-14T13:38:00Z'
    await calc.calculator(ESBJERG)
    assert.strictEqual(fetchJson.of('tidewaterstation').length, 1, 'no retry within 5 min')
    state.now = '2026-09-14T13:41:00Z'
    await calc.calculator(ESBJERG)
    assert.strictEqual(fetchJson.of('tidewaterstation').length, 2)
  } finally {
    calc.stop()
  }
  const noObs = setup({ overrides: { observation: new Error('ECONNRESET') } })
  try {
    const v = byPath(await noObs.calc.calculator(ESBJERG))
    assert.strictEqual(v['environment.tide.heightNow'], 0.486, 'falls back to the prediction')
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-09-14T15:38:00.000Z')
    assert.ok(noObs.app.pluginErrors.some(m => m.includes('ECONNRESET')))
  } finally {
    noObs.calc.stop()
  }
  const garbage = setup({ overrides: { tidewaterstation: { message: 'Service Unavailable' } } })
  try {
    assert.strictEqual(await garbage.calc.calculator(ESBJERG), undefined)
    assert.ok(garbage.app.pluginErrors.some(m => m.includes('unexpected response')))
  } finally {
    garbage.calc.stop()
  }
})

test('measurements over an hour old are not used for height now', async () => {
  const stale = setup()
  stale.state.now = '2026-09-14T14:45:00Z' // the latest measurement in the fixture is from 13:30
  try {
    const v = byPath(await stale.calc.calculator(ESBJERG))
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightPredicted'])
  } finally {
    stale.calc.stop()
  }
})

test('tides resource: coming highs and lows in the signalk-tides shape', async () => {
  const { calc } = setup()
  try {
    const forecast = await calc.tideForecast()
    assert.strictEqual(forecast.datum, 'DVR90')
    assert.strictEqual(forecast.units, 'meters')
    assert.deepStrictEqual(forecast.station, { id: 'dmi/25149', name: 'Esbjerg Havn', latitude: 55.4602, longitude: 8.4397 })
    assert.deepStrictEqual(forecast.extremes[0], { time: '2026-09-14T15:38:00.000Z', level: 0.88, high: true, low: false, label: 'High' })
    assert.deepStrictEqual(forecast.extremes[1], { time: '2026-09-14T21:47:00.000Z', level: -0.968, high: false, low: true, label: 'Low' })
    assert.ok(forecast.extremes.every(e => new Date(e.time) > new Date('2026-09-14T13:35:00Z')))
  } finally {
    calc.stop()
  }
  const far = setup()
  far.state.position = FREDRIKSTAD
  try {
    await assert.rejects(far.calc.tideForecast(), /No DMI tide station within 50 km/)
  } finally {
    far.calc.stop()
  }
})

test('re-publishes from the cache on a timer', async () => {
  const { calc, app, fetchJson } = setup({ republishInterval: 30 })
  try {
    await calc.calculator(ESBJERG)
    await wait(100)
    assert.ok(app.messages.some(m => m.updates[0].values), 'published by the timer')
    assert.strictEqual(fetchJson.calls.length, 5)
  } finally {
    calc.stop()
  }
})

test('HTTP: sends the User-Agent and reads a GeoJSON body', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req)
    if (req.url.includes('fail')) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('busy')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/geo+json' })
    res.end(JSON.stringify(fixture('dmi-observation.json')))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/v2/oceanObs/collections/observation/items`
  try {
    const body = await dmi.defaultFetchJson(base + '?limit=10000')
    assert.strictEqual(body.features.length, 6)
    assert.ok(/^signalk-tides-api\//.test(seen[0].headers['user-agent']))
    await assert.rejects(dmi.defaultFetchJson(base + '?fail=1'))
  } finally {
    server.close()
  }
})

test('index.js loads the provider and its options', () => {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-index-'))
  fs.writeFileSync(path.join(configPath, 'noaastations.json'), '{"stations":[]}')
  const app = Object.assign(mockApp({}), { config: { configPath } })
  const plugin = require('../index.js')(app)
  const tides = plugin.schema().properties.tides.properties
  assert.strictEqual(tides.dmi.title, 'DMI (Denmark, Greenland, Faroe Islands)')
  assert.deepStrictEqual(tides.dmiDatum.enum, ['DVR90', 'LAT'])
  assert.strictEqual(tides.dmiRefreshMinutes.default, 10)
  assert.strictEqual(tides.dmiMaxDistanceKm.default, 50)
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
