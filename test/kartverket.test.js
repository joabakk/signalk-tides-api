/*
 * Offline tests for calcs/kartverket.js. Run with: node test/kartverket.test.js
 *
 * kartverket-live-*.xml are real responses from Kartverket (Fredrikstad, 2026-10-12).
 * The other fixtures are synthetic, written in the same format.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const kartverket = require('../calcs/kartverket')

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const FREDRIKSTAD = { latitude: 59.21, longitude: 10.95 }
const VIKER = { latitude: 59.036, longitude: 10.95 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function mockApp (state) {
  return {
    selfId: 'urn:mrn:imo:mmsi:000000000',
    errors: [],
    providerErrors: [],
    statuses: [],
    messages: [],
    debug () {},
    error (m) { this.errors.push(m) },
    setProviderError (m) { this.providerErrors.push(m) },
    setProviderStatus (m) { this.statuses.push(m) },
    handleMessage (id, delta) { this.messages.push(delta) },
    getSelfPath (p) {
      if (p === 'navigation.datetime') return state.now ? { value: state.now } : undefined
      if (p === 'navigation.position') return state.position ? { value: state.position } : undefined
      return undefined
    }
  }
}

// Serves fixtures by datatype and records every URL requested.
function mockFetch (overrides) {
  const calls = []
  const fn = url => {
    calls.push(new URL(url))
    const datatype = new URL(url).searchParams.get('datatype')
    const o = overrides && overrides[datatype]
    if (o instanceof Error) return Promise.reject(o)
    if (typeof o === 'string') return Promise.resolve(o)
    const files = { tab: 'kartverket-tab.xml', all: 'kartverket-all.xml', obs: 'kartverket-obs.xml' }
    return Promise.resolve(fixture(files[datatype]))
  }
  fn.calls = calls
  return fn
}

function setup (opts) {
  const state = { now: '2026-10-12T15:10:00Z', position: FREDRIKSTAD }
  const app = mockApp(state)
  const fetchText = mockFetch(opts && opts.overrides)
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ kartverket: true }, opts && opts.tides) } }
  const calc = kartverket(app, plugin, { fetchText })
  return { state, app, fetchText, plugin, calc }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

// --- parser -----------------------------------------------------------------

test('parses the water level series and converts cm to metres', () => {
  const r = kartverket.parseTideXml(fixture('kartverket-all.xml'))
  assert.deepStrictEqual(Object.keys(r.series).sort(), ['forecast', 'prediction', 'weathereffect'])
  assert.strictEqual(r.series.prediction.length, 32)
  assert.strictEqual(r.series.prediction[0].value, 0.437)
  assert.strictEqual(r.series.prediction[0].time.toISOString(), '2026-10-12T14:00:00.000Z')
  assert.strictEqual(r.reflevelcode, 'CD')
  assert.strictEqual(r.location.descr, 'Water level & tide, location')
  assert.strictEqual(r.nodata, undefined)
})

test('parses the tide table and finds the next high and low', () => {
  const r = kartverket.parseTideXml(fixture('kartverket-tab.xml'))
  const points = kartverket.extremesFrom(r)
  assert.strictEqual(points.length, 5)
  const { high, low } = kartverket.nextExtremes(points, new Date('2026-10-12T15:10:00Z'))
  assert.strictEqual(high.time.toISOString(), '2026-10-12T18:47:00.000Z')
  assert.strictEqual(high.value, 0.7)
  assert.strictEqual(low.time.toISOString(), '2026-10-13T01:00:00.000Z')
  assert.strictEqual(low.value, 0.4)
})

test('reports nodata instead of failing', () => {
  const r = kartverket.parseTideXml(fixture('kartverket-nodata.xml'))
  assert.strictEqual(r.nodata, 'Position is out of range or on land')
  assert.deepStrictEqual(r.series, {})
})

test('throws on an API error and on a non-tide response', () => {
  assert.throws(() => kartverket.parseTideXml('<tide><error>Unknown refcode</error></tide>'), /Unknown refcode/)
  assert.throws(() => kartverket.parseTideXml('<html><body>Service moved</body></html>'), /unexpected response/)
  assert.throws(() => kartverket.parseTideXml(undefined), /empty response/)
})

test('times without an offset are taken as UTC, attributes in any order and quoting', () => {
  const r = kartverket.parseTideXml(
    "<tide><data type='observation' unit='m'><waterlevel flag='obs' time='2026-10-12T15:00' value='0.61' /></data></tide>")
  assert.strictEqual(r.series.observation[0].time.toISOString(), '2026-10-12T15:00:00.000Z')
  assert.strictEqual(r.series.observation[0].value, 0.61)
})

test('interpolates between hourly values', () => {
  const r = kartverket.parseTideXml(fixture('kartverket-all.xml'))
  // 15:00 50.0 cm, 16:00 57.4 cm
  assert.strictEqual(kartverket.valueAt(r.series.prediction, new Date('2026-10-12T15:10:00Z')), 0.512)
  assert.strictEqual(kartverket.valueAt(r.series.prediction, new Date('2026-10-12T15:00:00Z')), 0.5)
  assert.strictEqual(kartverket.valueAt(r.series.prediction, new Date('2026-10-12T13:00:00Z')), null)
})

test('derives high and low from the prediction when the table has no flags', () => {
  const r = kartverket.parseTideXml(fixture('kartverket-all.xml'))
  const points = kartverket.extremesInSeries(r.series.prediction)
  const { high, low } = kartverket.nextExtremes(points, new Date('2026-10-12T15:10:00Z'))
  assert.ok(Math.abs(high.time - new Date('2026-10-12T18:47:00Z')) <= 10 * 60 * 1000, high.time.toISOString())
  assert.ok(Math.abs(high.value - 0.7) <= 0.01, String(high.value))
  assert.ok(Math.abs(low.time - new Date('2026-10-13T01:00:00Z')) <= 10 * 60 * 1000, low.time.toISOString())
  assert.ok(Math.abs(low.value - 0.4) <= 0.01, String(low.value))
})

test('live response: parses all four series, including values without a flag', () => {
  const r = kartverket.parseTideXml(fixture('kartverket-live-all.xml'))
  assert.deepStrictEqual(Object.keys(r.series).sort(), ['forecast', 'observation', 'prediction', 'weathereffect'])
  assert.strictEqual(r.series.observation[0].value, 0.588)
  assert.strictEqual(r.series.weathereffect[0].value, -0.127)
  assert.strictEqual(r.series.weathereffect[0].flag, '')
  assert.strictEqual(r.location.obscode, 'VIK')
  assert.strictEqual(r.reflevelcode, 'CD')
})

test('live response: tide table', () => {
  const points = kartverket.extremesFrom(kartverket.parseTideXml(fixture('kartverket-live-tab.xml')))
  assert.strictEqual(points.length, 5)
  const { high, low } = kartverket.nextExtremes(points, new Date('2026-10-12T12:00:00Z'))
  assert.strictEqual(high.time.toISOString(), '2026-10-12T16:45:00.000Z')
  assert.strictEqual(high.value, 0.771)
  assert.strictEqual(low.time.toISOString(), '2026-10-12T22:21:00.000Z')
  assert.strictEqual(low.value, 0.568)
})

// --- provider -----------------------------------------------------------------

test('publishes high, low and height now with the expected request', async () => {
  const { calc, fetchText, app } = setup()
  try {
    assert.strictEqual(calc.optionKey, 'kartverket')
    assert.strictEqual(calc.group, 'tides')
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.strictEqual(v['environment.tide.heightHigh'], 0.7)
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-12T18:47:00.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], 0.4)
    assert.strictEqual(v['environment.tide.timeLow'], '2026-10-13T01:00:00.000Z')
    assert.strictEqual(v['environment.tide.heightPredicted'], 0.512)
    // no observation at a non-station position, so height now is the forecast
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightForecast'])
    assert.ok(v['environment.tide.weatherEffect'] > 0.1)
    assert.ok(Math.abs(v['environment.tide.heightNow'] - (0.512 + v['environment.tide.weatherEffect'])) < 0.002)
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)

    assert.strictEqual(fetchText.calls.length, 2)
    const q = fetchText.calls[0].searchParams
    assert.strictEqual(fetchText.calls[0].origin + fetchText.calls[0].pathname, kartverket.DEFAULT_API_URL)
    assert.strictEqual(q.get('tide_request'), 'locationdata')
    assert.strictEqual(q.get('lat'), '59.2100')
    assert.strictEqual(q.get('lon'), '10.9500')
    assert.strictEqual(q.get('fromtime'), '2026-10-12T14:00')
    assert.strictEqual(q.get('totime'), '2026-10-13T21:10')
    assert.strictEqual(q.get('refcode'), 'CD')
    assert.strictEqual(q.get('lang'), 'en')
    assert.strictEqual(q.get('interval'), '60')
    assert.strictEqual(q.get('tzone'), '0')
    assert.strictEqual(q.get('dst'), '0')
    assert.deepStrictEqual(fetchText.calls.map(u => u.searchParams.get('datatype')), ['tab', 'all'])
    assert.ok(app.statuses.some(s => s.includes('Kartverket')), 'attribution in status')
    assert.deepStrictEqual(app.providerErrors, [])
  } finally {
    calc.stop()
  }
})

test('live responses: height now is the observation, with prediction, forecast and weather effect', async () => {
  const { calc, state } = setup({ overrides: { tab: fixture('kartverket-live-tab.xml'), all: fixture('kartverket-live-all.xml') } })
  state.now = '2026-10-12T16:30:00Z'
  try {
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.strictEqual(v['environment.tide.heightHigh'], 0.771)
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-12T16:45:00.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], 0.568)
    assert.strictEqual(v['environment.tide.timeLow'], '2026-10-12T22:21:00.000Z')
    assert.strictEqual(v['environment.tide.heightNow'], 0.642) // observation at 16:00
    assert.strictEqual(v['environment.tide.heightObserved'], 0.642)
    assert.strictEqual(v['environment.tide.heightPredicted'], 0.762)
    assert.strictEqual(v['environment.tide.heightForecast'], 0.642)
    assert.ok(Math.abs(v['environment.tide.weatherEffect'] - -0.1085) < 0.001, String(v['environment.tide.weatherEffect']))
  } finally {
    calc.stop()
  }
})

test('caches: water level every 30 min, tide table only after the next event', async () => {
  const { calc, fetchText, state } = setup()
  try {
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 2)

    state.now = '2026-10-12T15:30:00Z'
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.strictEqual(fetchText.calls.length, 2, 'no request within 30 min')
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-12T18:47:00.000Z')

    state.now = '2026-10-12T15:41:00Z'
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 3)
    assert.strictEqual(fetchText.calls[2].searchParams.get('datatype'), 'all')

    state.now = '2026-10-12T18:48:00Z' // high tide has passed
    const after = byPath(await calc.calculator(FREDRIKSTAD))
    const types = fetchText.calls.slice(3).map(u => u.searchParams.get('datatype'))
    assert.deepStrictEqual(types, ['tab', 'all'])
    assert.strictEqual(after['environment.tide.timeHigh'], '2026-10-13T07:12:00.000Z')
    assert.strictEqual(after['environment.tide.timeLow'], '2026-10-13T01:00:00.000Z')
  } finally {
    calc.stop()
  }
})

test('refetches when the boat has moved more than 5 km', async () => {
  const { calc, fetchText } = setup()
  try {
    await calc.calculator(FREDRIKSTAD)
    await calc.calculator({ latitude: 59.22, longitude: 10.95 }) // ~1 km
    assert.strictEqual(fetchText.calls.length, 2)
    await calc.calculator({ latitude: 59.30, longitude: 10.95 }) // ~10 km
    assert.strictEqual(fetchText.calls.length, 4)
  } finally {
    calc.stop()
  }
})

test('uses the configured reference level and refresh interval', async () => {
  const { calc, fetchText, state } = setup({ tides: { kartverketRefcode: 'MSL', kartverketRefreshMinutes: 60 } })
  try {
    await calc.calculator(FREDRIKSTAD)
    assert.ok(fetchText.calls.every(u => u.searchParams.get('refcode') === 'MSL'))
    state.now = '2026-10-12T15:45:00Z'
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 2, 'no refresh before 60 min')
  } finally {
    calc.stop()
  }
})

test('refresh interval is never below 10 minutes', async () => {
  const { calc, fetchText, state } = setup({ tides: { kartverketRefreshMinutes: 1 } })
  try {
    await calc.calculator(FREDRIKSTAD)
    state.now = '2026-10-12T15:15:00Z'
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 2)
    state.now = '2026-10-12T15:21:00Z'
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 3)
  } finally {
    calc.stop()
  }
})

test('adds observed level from a configured station', async () => {
  const { calc, fetchText } = setup({ tides: { kartverketStationLatitude: VIKER.latitude, kartverketStationLongitude: VIKER.longitude } })
  try {
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    const obsCall = fetchText.calls.find(u => u.searchParams.get('datatype') === 'obs')
    assert.ok(obsCall, 'observation requested')
    assert.strictEqual(obsCall.searchParams.get('lat'), '59.0360')
    assert.strictEqual(v['environment.tide.heightObserved'], 0.643)
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightForecast'])
  } finally {
    calc.stop()
  }
})

test('never rejects: network errors are reported and retries back off', async () => {
  const { calc, fetchText, state, app } = setup({ overrides: { all: new Error('ETIMEDOUT'), tab: new Error('ETIMEDOUT') } })
  try {
    assert.strictEqual(await calc.calculator(FREDRIKSTAD), undefined)
    assert.ok(app.providerErrors.some(m => m.includes('ETIMEDOUT')))
    assert.ok(app.errors.length >= 1)
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 2, 'no retry within the back-off')
    state.now = '2026-10-12T15:16:00Z'
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 4, 'retry after the back-off')
  } finally {
    calc.stop()
  }
})

test('back-off doubles while the service stays down and resets after success', async () => {
  let down = true
  const good = mockFetch()
  const calls = []
  const fetchText = url => { calls.push(url); return down ? Promise.reject(new Error('ECONNREFUSED')) : good(url) }
  const state = { now: '2026-10-12T15:00:00Z' }
  const app = mockApp(state)
  const calc = kartverket(app, { id: 'tides-api', properties: { tides: { kartverket: true } } }, { fetchText })
  const at = async iso => { state.now = iso; await calc.calculator(FREDRIKSTAD); return calls.length }
  try {
    assert.strictEqual(await at('2026-10-12T15:00:00Z'), 2) // fail, wait 5 min
    assert.strictEqual(await at('2026-10-12T15:05:00Z'), 4) // fail, wait 10 min
    assert.strictEqual(await at('2026-10-12T15:14:00Z'), 4)
    assert.strictEqual(await at('2026-10-12T15:15:00Z'), 6) // fail, wait 20 min
    assert.strictEqual(await at('2026-10-12T15:34:00Z'), 6)
    assert.strictEqual(await at('2026-10-12T15:35:00Z'), 8) // fail, wait 30 min (cap)
    assert.strictEqual(await at('2026-10-12T16:04:00Z'), 8)
    down = false
    assert.strictEqual(await at('2026-10-12T16:05:00Z'), 10) // recovers
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.ok(v['environment.tide.timeHigh'])
  } finally {
    calc.stop()
  }
})

test('a position without data is asked again only after the update interval', async () => {
  const { calc, fetchText, state } = setup({ overrides: { tab: fixture('kartverket-nodata.xml'), all: fixture('kartverket-nodata.xml') } })
  try {
    await calc.calculator(FREDRIKSTAD)
    state.now = '2026-10-12T15:30:00Z'
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 2)
    state.now = '2026-10-12T15:40:00Z'
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(fetchText.calls.length, 4)
  } finally {
    calc.stop()
  }
})

test('keeps publishing cached values when a later refresh fails', async () => {
  let fail = false
  const state = { now: '2026-10-12T15:10:00Z', position: FREDRIKSTAD }
  const app = mockApp(state)
  const good = mockFetch()
  const fetchText = url => fail ? Promise.reject(new Error('ECONNREFUSED')) : good(url)
  const plugin = { id: 'tides-api', properties: { tides: { kartverket: true } } }
  const calc = kartverket(app, plugin, { fetchText })
  try {
    await calc.calculator(FREDRIKSTAD)
    fail = true
    state.now = '2026-10-12T15:45:00Z'
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-12T18:47:00.000Z')
    assert.ok(typeof v['environment.tide.heightNow'] === 'number')
    assert.ok(app.providerErrors.some(m => m.includes('ECONNREFUSED')))
  } finally {
    calc.stop()
  }
})

test('nodata and API errors are reported, not thrown', async () => {
  const nodata = setup({ overrides: { tab: fixture('kartverket-nodata.xml'), all: fixture('kartverket-nodata.xml') } })
  try {
    assert.strictEqual(await nodata.calc.calculator(FREDRIKSTAD), undefined)
    assert.ok(nodata.app.providerErrors.some(m => m.includes('out of range or on land')))
  } finally {
    nodata.calc.stop()
  }
  const broken = setup({ overrides: { tab: '<html>moved</html>', all: '<tide><error>Unknown refcode</error></tide>' } })
  try {
    assert.strictEqual(await broken.calc.calculator(FREDRIKSTAD), undefined)
    assert.ok(broken.app.providerErrors.some(m => m.includes('unexpected response')))
    assert.ok(broken.app.providerErrors.some(m => m.includes('Unknown refcode')))
  } finally {
    broken.calc.stop()
  }
})

test('tide table without flags falls back to the prediction', async () => {
  const flagless = fixture('kartverket-tab.xml').replace(/ flag="(high|low)"/g, '')
  const { calc, app } = setup({ overrides: { tab: flagless } })
  try {
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.ok(Math.abs(new Date(v['environment.tide.timeHigh']) - new Date('2026-10-12T18:47:00Z')) <= 10 * 60 * 1000)
    assert.ok(Math.abs(v['environment.tide.heightLow'] - 0.4) <= 0.01)
    assert.deepStrictEqual(app.providerErrors, [])
  } finally {
    calc.stop()
  }
})

test('height now uses an observation at the position when there is one', async () => {
  const withObs = fixture('kartverket-all.xml').replace('  </locationdata>',
    '    <data type="observation" unit="cm">\n' +
    '      <waterlevel value="66.0" time="2026-10-12T14:00:00+00:00" flag="obs"/>\n' +
    '      <waterlevel value="66.6" time="2026-10-12T15:00:00+00:00" flag="obs"/>\n' +
    '    </data>\n  </locationdata>')
  const { calc } = setup({ overrides: { all: withObs } })
  try {
    const v = byPath(await calc.calculator(FREDRIKSTAD))
    assert.strictEqual(v['environment.tide.heightNow'], 0.666)
    assert.strictEqual(v['environment.tide.heightObserved'], 0.666)
    assert.notStrictEqual(v['environment.tide.heightForecast'], 0.666)
  } finally {
    calc.stop()
  }
})

test('observations older than 3 hours are ignored', () => {
  const series = [{ time: new Date('2026-10-12T11:00:00Z'), value: 0.6, flag: 'obs' }]
  assert.strictEqual(kartverket.latestObservation(series, new Date('2026-10-12T15:10:00Z')), null)
  assert.strictEqual(kartverket.latestObservation(series, new Date('2026-10-12T13:10:00Z')).value, 0.6)
})

test('requests are made one at a time', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const good = mockFetch()
  const fetchText = url => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise(resolve => setTimeout(resolve, 20)).then(() => good(url)).then(text => { inFlight--; return text })
  }
  const app = mockApp({ now: '2026-10-12T15:10:00Z' })
  const plugin = { id: 'tides-api', properties: { tides: { kartverket: true, kartverketStationLatitude: VIKER.latitude, kartverketStationLongitude: VIKER.longitude } } }
  const calc = kartverket(app, plugin, { fetchText })
  try {
    await calc.calculator(FREDRIKSTAD)
    assert.strictEqual(good.calls.length, 3)
    assert.strictEqual(maxInFlight, 1)
  } finally {
    calc.stop()
  }
})

test('re-publishes from the cache on a timer without new requests', async () => {
  const state = { now: '2026-10-12T15:10:00Z', position: FREDRIKSTAD }
  const app = mockApp(state)
  const fetchText = mockFetch()
  const plugin = { id: 'tides-api', properties: { tides: { kartverket: true } } }
  const calc = kartverket(app, plugin, { fetchText, republishInterval: 30 })
  try {
    await calc.calculator(FREDRIKSTAD)
    state.now = '2026-10-12T15:20:00Z'
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(app.messages.length >= 1, 'published by the timer')
    const delta = app.messages[app.messages.length - 1]
    assert.strictEqual(delta.context, 'vessels.' + app.selfId)
    const v = byPath(delta.updates[0].values)
    // 15:20 is between 15:00 (50.0) and 16:00 (57.4)
    assert.strictEqual(v['environment.tide.heightPredicted'], 0.525)
    assert.strictEqual(fetchText.calls.length, 2)
  } finally {
    calc.stop()
  }
  const count = app.messages.length
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.strictEqual(app.messages.length, count, 'stop() ends the timer')
})

test('skips without a position and does not query', async () => {
  const { calc, fetchText } = setup()
  try {
    assert.strictEqual(await calc.calculator(undefined), undefined)
    assert.strictEqual(await calc.calculator({ latitude: null, longitude: 10 }), undefined)
    assert.strictEqual(fetchText.calls.length, 0)
  } finally {
    calc.stop()
  }
})

test('concurrent calls share one request', async () => {
  const { calc, fetchText } = setup()
  try {
    const [a, b] = await Promise.all([calc.calculator(FREDRIKSTAD), calc.calculator(FREDRIKSTAD)])
    assert.strictEqual(fetchText.calls.length, 2)
    assert.deepStrictEqual(a, b)
  } finally {
    calc.stop()
  }
})

// --- real HTTP code path against a local server --------------------------------

test('HTTP: sends the User-Agent and reads an XML body', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req)
    if (req.url.includes('fail')) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('busy')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' })
    res.end(fixture('kartverket-tab.xml'))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/tideapi.php`
  try {
    const text = await kartverket.defaultFetchText(base + '?tide_request=locationdata')
    assert.strictEqual(text, fixture('kartverket-tab.xml'))
    assert.strictEqual(seen[0].headers['user-agent'], kartverket.USER_AGENT)
    assert.ok(/^signalk-tides-api\/\d+\.\d+\.\d+ /.test(kartverket.USER_AGENT))
    await assert.rejects(kartverket.defaultFetchText(base + '?fail=1'))
  } finally {
    server.close()
  }
})

// --- plugin wiring ---------------------------------------------------------------

test('index.js loads the provider and adds its options to the schema', () => {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tides-test-'))
  // keep the NOAA provider offline: it reads this file instead of downloading
  fs.writeFileSync(path.join(configPath, 'noaastations.json'), '{"stations":[]}')
  const app = Object.assign(mockApp({}), { config: { configPath }, use () {} })
  const plugin = require('../index.js')(app)
  const schema = plugin.schema()
  const tides = schema.properties.tides.properties
  assert.strictEqual(tides.kartverket.title, 'Kartverket (Norway)')
  assert.deepStrictEqual(tides.kartverketRefcode.enum, ['CD', 'MSL', 'NN2000'])
  assert.strictEqual(tides.kartverketRefcode.default, 'CD')
  assert.strictEqual(tides.kartverketRefreshMinutes.default, 30)
  assert.ok(plugin.uiSchema().tides['ui:order'].includes('kartverketRefcode'))
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
