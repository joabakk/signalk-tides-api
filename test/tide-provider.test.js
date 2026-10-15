/*
 * Offline tests for lib/tide-provider.js, the shared plumbing of the newer providers,
 * using a fake provider. Run with: node test/tide-provider.test.js
 */
const assert = require('assert')
const http = require('http')
const createProvider = require('../lib/tide-provider')

const POS = { latitude: 59.21, longitude: 10.95 }
const T = iso => new Date(iso)

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

// A provider whose data is whatever the test puts in `data`; `fetch` counts and can fail.
function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-12T16:30:00Z', position: POS }
  const app = mockApp(state)
  const data = Object.assign({
    station: { id: 'A1', name: 'Alpha', latitude: 59.2, longitude: 10.9 },
    datum: 'MSL',
    extremes: [
      { time: T('2026-10-12T16:45:00Z'), value: 0.771, flag: 'high' },
      { time: T('2026-10-12T22:21:00Z'), value: 0.568, flag: 'low' },
      { time: T('2026-10-13T05:05:00Z'), value: 0.721, flag: 'high' }
    ],
    predicted: [
      { time: T('2026-10-12T16:00:00Z'), value: 0.755 },
      { time: T('2026-10-12T17:00:00Z'), value: 0.769 }
    ],
    forecast: [
      { time: T('2026-10-12T16:00:00Z'), value: 0.635 },
      { time: T('2026-10-12T17:00:00Z'), value: 0.649 }
    ],
    observed: [{ time: T('2026-10-12T16:00:00Z'), value: 0.642 }]
  }, opts.data)
  const calls = []
  const spec = {
    optionKey: 'fake',
    title: 'Fake',
    name: 'Fake',
    attribution: 'Fake data, CC0',
    refreshKey: 'fakeRefreshMinutes',
    defaultRefreshMinutes: 30,
    properties: { fakeRefreshMinutes: { type: 'number', default: 30 } },
    update (ctx) {
      if (opts.update) return opts.update(ctx, calls)
      if (!ctx.state.fetchedAt || ctx.t - ctx.state.fetchedAt >= ctx.refreshMs) {
        ctx.job('data', 'data', () => {
          calls.push(ctx.now.toISOString())
          if (opts.fail) return Promise.reject(opts.fail)
          ctx.state.fetchedAt = ctx.t
        })
      }
    },
    view (ctx) { return ctx.state.fetchedAt || opts.update ? data : null }
  }
  Object.assign(spec, opts.spec)
  const plugin = opts.plugin || { id: 'tides-api', properties: { tides: Object.assign({ fake: true }, opts.tides) } }
  const calc = createProvider(app, plugin, spec, { republishInterval: opts.republishInterval })
  return { state, app, calc, calls, data }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('publishes next high and low, levels now and the weather effect', async () => {
  const { calc, app } = setup()
  try {
    assert.strictEqual(calc.optionKey, 'fake')
    assert.strictEqual(calc.group, 'tides')
    const v = byPath(await calc.calculator(POS))
    assert.strictEqual(v['environment.tide.heightHigh'], 0.771)
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-12T16:45:00.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], 0.568)
    assert.strictEqual(v['environment.tide.timeLow'], '2026-10-12T22:21:00.000Z')
    assert.strictEqual(v['environment.tide.heightPredicted'], 0.762)
    assert.strictEqual(v['environment.tide.heightForecast'], 0.642)
    assert.strictEqual(v['environment.tide.heightObserved'], 0.642)
    assert.strictEqual(v['environment.tide.heightNow'], 0.642)
    assert.strictEqual(v['environment.tide.weatherEffect'], -0.113) // 0.642 - 0.755 at 16:00
    assert.ok(app.statuses[0].includes('Fake Alpha (MSL), height now from measurement. Data: Fake data, CC0'))
    const metas = app.messages.filter(m => m.updates[0].meta)
    assert.strictEqual(metas.length, 1)
    assert.ok(metas[0].updates[0].meta.every(m => m.value.units === 'm' && m.value.description.endsWith('from Fake')))
  } finally {
    calc.stop()
  }
})

test('height now falls back to the forecast, then the prediction', async () => {
  const noObs = setup({ data: { observed: [] } })
  try {
    const v = byPath(await noObs.calc.calculator(POS))
    assert.strictEqual(v['environment.tide.heightNow'], 0.642)
    assert.strictEqual(v['environment.tide.weatherEffect'], -0.12) // forecast - prediction
    assert.ok(noObs.app.statuses[0].includes('from forecast'))
  } finally {
    noObs.calc.stop()
  }
  const predictionOnly = setup({ data: { observed: [], forecast: [] } })
  try {
    const v = byPath(await predictionOnly.calc.calculator(POS))
    assert.strictEqual(v['environment.tide.heightNow'], 0.762)
    assert.strictEqual(v['environment.tide.weatherEffect'], undefined)
  } finally {
    predictionOnly.calc.stop()
  }
})

test('measurements older than the limit are not used', async () => {
  const { calc } = setup({ data: { observed: [{ time: T('2026-10-12T12:00:00Z'), value: 0.6 }] } })
  try {
    const v = byPath(await calc.calculator(POS))
    assert.strictEqual(v['environment.tide.heightObserved'], undefined)
    assert.strictEqual(v['environment.tide.heightNow'], 0.642)
  } finally {
    calc.stop()
  }
})

test('a weather effect series wins, the latest value is used between points', async () => {
  const { calc } = setup({ data: { weatherEffect: [{ time: T('2026-10-12T16:00:00Z'), value: -0.104 }] } })
  try {
    const v = byPath(await calc.calculator(POS))
    assert.strictEqual(v['environment.tide.weatherEffect'], -0.104)
  } finally {
    calc.stop()
  }
})

test('high and low come from the prediction when there is no tide table', async () => {
  const predicted = []
  for (let h = 0; h <= 30; h++) {
    const time = new Date(Date.UTC(2026, 9, 12, 12 + h))
    predicted.push({ time, value: 0.5 * Math.cos(2 * Math.PI * (h - 6) / 12.42) })
  }
  const { calc } = setup({ data: { extremes: [], predicted } })
  try {
    const v = byPath(await calc.calculator(POS))
    assert.ok(v['environment.tide.timeHigh'] > '2026-10-12T16:30:00Z')
    assert.ok(Math.abs(v['environment.tide.heightHigh'] - 0.5) < 0.01)
    assert.ok(v['environment.tide.heightLow'] < -0.49)
  } finally {
    calc.stop()
  }
})

test('caches: asks again only after the refresh interval', async () => {
  const { calc, calls, state } = setup()
  try {
    await calc.calculator(POS)
    state.now = '2026-10-12T16:59:00Z'
    await calc.calculator(POS)
    assert.strictEqual(calls.length, 1)
    state.now = '2026-10-12T17:00:00Z'
    await calc.calculator(POS)
    assert.strictEqual(calls.length, 2)
  } finally {
    calc.stop()
  }
})

test('failures are reported, never thrown, and back off 5, 10, 20 min up to 30', async () => {
  const { calc, calls, state, app } = setup({ fail: new Error('ECONNREFUSED') })
  const at = async iso => { state.now = iso; await calc.calculator(POS); return calls.length }
  try {
    assert.strictEqual(await calc.calculator(POS), undefined)
    assert.ok(app.pluginErrors.some(m => m === 'Fake data: ECONNREFUSED'))
    assert.strictEqual(await at('2026-10-12T16:34:00Z'), 1)
    assert.strictEqual(await at('2026-10-12T16:35:00Z'), 2) // after 5 min
    assert.strictEqual(await at('2026-10-12T16:44:00Z'), 2)
    assert.strictEqual(await at('2026-10-12T16:45:00Z'), 3) // after 10 min
    assert.strictEqual(await at('2026-10-12T17:05:00Z'), 4) // after 20 min
    assert.strictEqual(await at('2026-10-12T17:34:00Z'), 4)
    assert.strictEqual(await at('2026-10-12T17:35:00Z'), 5) // capped at 30 min
  } finally {
    calc.stop()
  }
})

test('no data for the position waits a whole interval; quiet errors are not reported', async () => {
  const noData = setup({ fail: createProvider.noData('no stations here') })
  try {
    await noData.calc.calculator(POS)
    noData.state.now = '2026-10-12T16:59:00Z'
    await noData.calc.calculator(POS)
    assert.strictEqual(noData.calls.length, 1)
    noData.state.now = '2026-10-12T17:00:00Z'
    await noData.calc.calculator(POS)
    assert.strictEqual(noData.calls.length, 2)
  } finally {
    noData.calc.stop()
  }
  const outside = setup({ update: () => { throw createProvider.quiet('outside the area') } })
  try {
    assert.strictEqual(await outside.calc.calculator(POS), undefined)
    assert.deepStrictEqual(outside.app.pluginErrors, [])
    assert.ok(outside.app.debugs.some(m => m.includes('outside the area')))
  } finally {
    outside.calc.stop()
  }
})

test('jobs queued before update() throws still run (e.g. a station list refresh)', async () => {
  const ran = []
  const { calc, app } = setup({
    update: ctx => {
      ctx.job('stations', 'station list', () => { ran.push('stations') })
      throw createProvider.quiet('no station within 30 km')
    }
  })
  try {
    assert.strictEqual(await calc.calculator(POS), undefined)
    assert.deepStrictEqual(ran, ['stations'])
    assert.deepStrictEqual(app.pluginErrors, [])
  } finally {
    calc.stop()
  }
})

test('quiet job errors do not delay the next try', async () => {
  let near = false
  const { calc, state, calls } = setup({
    update: (ctx, calls) => ctx.job('compute', 'prediction', () => {
      calls.push(ctx.now.toISOString())
      if (!near) throw createProvider.quiet('no station within 50 km')
    })
  })
  try {
    await calc.calculator(POS)
    state.now = '2026-10-12T16:31:00Z'
    near = true
    await calc.calculator(POS)
    assert.strictEqual(calls.length, 2, 'asked again a minute later')
  } finally {
    calc.stop()
  }
})

test('a failure at one station does not delay requests for another', async () => {
  const { calc, state, calls } = setup({
    update: (ctx, calls) => {
      ctx.state.station = { id: state.stationId }
      ctx.job('extremes', 'high and low waters', () => {
        calls.push(state.stationId)
        if (state.stationId === 'A') throw createProvider.noData('no highs and lows at A')
      })
    }
  })
  state.stationId = 'A'
  try {
    await calc.calculator(POS)
    state.now = '2026-10-12T16:31:00Z'
    await calc.calculator(POS)
    assert.deepStrictEqual(calls, ['A'], 'A waits')
    state.stationId = 'B'
    await calc.calculator(POS)
    assert.deepStrictEqual(calls, ['A', 'B'], 'B is asked at once')
  } finally {
    calc.stop()
  }
})

test('a fallback publishes nothing while a station provider does, but still serves the resource', async () => {
  const plugin = { id: 'tides-api', properties: { tides: { fake: true, station: true } } }
  const fallback = setup({ plugin, spec: { fallback: true } })
  const station = setup({ plugin, spec: { optionKey: 'station' } })
  try {
    assert.ok((await fallback.calc.calculator(POS)).length > 0, 'alone, the fallback publishes')
    assert.ok((await station.calc.calculator(POS)).length > 0)
    assert.ok(plugin.tideDeltasAt.station > 0)
    assert.strictEqual(plugin.tideDeltasAt.fake, undefined)
    assert.strictEqual(await fallback.calc.calculator(POS), undefined)
    const statuses = fallback.app.statuses.length
    await fallback.calc.calculator(POS)
    assert.strictEqual(fallback.app.statuses.length, statuses, 'no status from a quiet fallback')
    assert.strictEqual((await fallback.calc.tideForecast()).datum, 'MSL')
    plugin.tideDeltasAt.station = Date.now() - 11 * 60e3
    assert.ok((await fallback.calc.calculator(POS)).length > 0, 'publishes again 10 min after the station provider stopped')
  } finally {
    fallback.calc.stop()
    station.calc.stop()
  }
})

test('requests run one at a time', async () => {
  let inFlight = 0
  let max = 0
  const { calc } = setup({
    update (ctx, calls) {
      for (const kind of ['a', 'b', 'c']) {
        ctx.job(kind, kind, () => {
          inFlight++
          max = Math.max(max, inFlight)
          return wait(10).then(() => { inFlight--; calls.push(kind) })
        })
      }
    }
  })
  try {
    await calc.calculator(POS)
    assert.strictEqual(max, 1)
  } finally {
    calc.stop()
  }
})

test('a request can queue more requests in the same pass', async () => {
  const order = []
  const { calc } = setup({
    update (ctx, calls) {
      ctx.job('first', 'first', () => {
        order.push('first')
        ctx.job('second', 'second', () => { order.push('second') })
      })
    }
  })
  try {
    await calc.calculator(POS)
    assert.deepStrictEqual(order, ['first', 'second'])
  } finally {
    calc.stop()
  }
})

test('station lists: fetched when missing or old, kept in a file, old list used on failure', async () => {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { stationList } = createProvider
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stations-'))
  let fetches = 0
  let fail = false
  const make = (now) => {
    const state = { now, position: POS }
    const app = Object.assign(mockApp(state), { getDataDirPath: () => dir })
    let seen
    const calc = createProvider(app, { id: 'x', properties: { tides: {} } }, {
      optionKey: 'fake', name: 'Fake', attribution: '',
      update (ctx) {
        stationList(ctx, 'fake-stations', 30 * 24 * 3600e3, () => {
          fetches++
          return fail ? Promise.reject(new Error('down')) : [{ id: 'S1', latitude: 1, longitude: 2 }]
        })
        ctx.job('read', 'read', () => { seen = ctx.state['stations:fake-stations'] })
      },
      view () { return null }
    })
    return { calc, app, seen: () => seen }
  }
  const a = make('2026-10-01T00:00:00Z')
  await a.calc.calculator(POS)
  a.calc.stop()
  assert.strictEqual(fetches, 1)
  assert.deepStrictEqual(a.seen().stations, [{ id: 'S1', latitude: 1, longitude: 2 }])
  await wait(30)
  const b = make('2026-10-20T00:00:00Z') // within a month: read from the file
  await b.calc.calculator(POS)
  b.calc.stop()
  assert.strictEqual(fetches, 1)
  fail = true
  const c = make('2026-11-05T00:00:00Z') // over a month: fetched again, fails, old list kept
  await c.calc.calculator(POS)
  c.calc.stop()
  assert.strictEqual(fetches, 2)
  assert.deepStrictEqual(c.seen().stations, [{ id: 'S1', latitude: 1, longitude: 2 }])
  assert.ok(c.app.pluginErrors.some(m => m.includes('station list: down')))
})

test('skips without a position', async () => {
  const { calc, calls } = setup()
  try {
    assert.strictEqual(await calc.calculator(undefined), undefined)
    assert.strictEqual(await calc.calculator({ latitude: 'x', longitude: 1 }), undefined)
    assert.strictEqual(calls.length, 0)
  } finally {
    calc.stop()
  }
})

test('tides resource in the signalk-tides shape', async () => {
  const { calc } = setup()
  try {
    assert.deepStrictEqual(await calc.tideForecast(), {
      datum: 'MSL',
      units: 'meters',
      station: { id: 'fake/A1', name: 'Alpha', latitude: 59.2, longitude: 10.9 },
      extremes: [
        { time: '2026-10-12T16:45:00.000Z', level: 0.771, high: true, low: false, label: 'High' },
        { time: '2026-10-12T22:21:00.000Z', level: 0.568, high: false, low: true, label: 'Low' },
        { time: '2026-10-13T05:05:00.000Z', level: 0.721, high: true, low: false, label: 'High' }
      ]
    })
  } finally {
    calc.stop()
  }
  const none = setup({ data: { station: null } })
  try {
    await assert.rejects(none.calc.tideForecast(), /No Fake tide predictions/)
  } finally {
    none.calc.stop()
  }
  const noPos = setup()
  noPos.state.position = undefined
  try {
    await assert.rejects(noPos.calc.tideForecast(), /No position/)
  } finally {
    noPos.calc.stop()
  }
})

test('re-publishes from the cache on a timer, stops with stop()', async () => {
  const { calc, app, calls } = setup({ republishInterval: 20 })
  await calc.calculator(POS)
  await wait(80)
  assert.ok(app.messages.some(m => m.updates[0].values && m.context === 'vessels.' + app.selfId))
  assert.strictEqual(calls.length, 1)
  calc.stop()
  const count = app.messages.length
  await wait(80)
  assert.strictEqual(app.messages.length, count)
})

test('HTTP helpers: User-Agent, GET text and JSON, POST JSON, empty answer', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, ua: req.headers['user-agent'], type: req.headers['content-type'], body })
      if (req.url === '/empty') { res.writeHead(204); res.end(); return }
      if (req.url === '/fail') { res.writeHead(500); res.end('oops'); return }
      if (req.url === '/text') { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end('<a>1</a>'); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const { getText, getJson, postJson } = createProvider.http
    assert.strictEqual(await getText(`${base}/text`), '<a>1</a>')
    assert.deepStrictEqual(await getJson(`${base}/json`), { ok: true, echo: null })
    assert.deepStrictEqual(await postJson(`${base}/post`, { a: 1 }), { ok: true, echo: { a: 1 } })
    assert.strictEqual(await postJson(`${base}/empty`, {}), null)
    await assert.rejects(getJson(`${base}/fail`), /HTTP 500: oops/)
    assert.ok(seen.every(s => /^signalk-tides-api\//.test(s.ua)))
    assert.ok(seen.find(s => s.method === 'POST').type.startsWith('application/json'))
  } finally {
    server.close()
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
