/*
 * Offline tests for calcs/linz.js. Run with: node test/linz.test.js
 * Fixture: the real LINZ tide table for Auckland 2026 (linz-live-auckland-2026.csv), captured
 * 2026-10-19. Data: LINZ, CC BY 4.0.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const linz = require('../calcs/linz')

const AUCKLAND_CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'linz-live-auckland-2026.csv'), 'utf8')
const AUCKLAND = { latitude: -36.84, longitude: 174.77 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function setup (opts) {
  opts = opts || {}
  const state = { now: opts.now || '2026-10-19T13:25:04Z', position: AUCKLAND }
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'linz-'))
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
  const getText = url => {
    urls.push(decodeURIComponent(url))
    if (url.endsWith('/Auckland%202026.csv')) return Promise.resolve(AUCKLAND_CSV)
    return Promise.reject(new Error('HTTP 404: <Error><Code>NoSuchKey</Code></Error>'))
  }
  const calc = linz(app, { id: 'tides-api', properties: { tides: { linz: true } } }, { getText })
  return { state, app, calc, urls, dataDir }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

test('parses the table: NZ daylight and standard time to UTC, highs and lows', () => {
  const { station, points } = linz.parseCsv(AUCKLAND_CSV)
  assert.deepStrictEqual([station.name, station.latitude], ['Auckland', -36.85])
  assert.ok(Math.abs(station.longitude - 174.7667) < 1e-4)
  // 20 Oct 2026 02:37 NZDT (UTC+13) and 15 Jun 2026, NZST (UTC+12)
  assert.deepStrictEqual(points.find(p => p.time.toISOString() === '2026-10-19T13:37:00.000Z'), { time: new Date('2026-10-19T13:37:00Z'), value: 2.6, flag: 'high' })
  const june = points.filter(p => p.time >= new Date('2026-06-14T12:00:00Z') && p.time < new Date('2026-06-15T12:00:00Z'))
  assert.ok(june.length >= 3)
  assert.ok(points.every((p, i) => i === 0 || p.flag !== points[i - 1].flag), 'highs and lows alternate')
  assert.ok(points.length > 1400)
})

test('Auckland: next high and low above chart datum, one download a year', async () => {
  const { calc, app, urls, state } = setup()
  try {
    const v = byPath(await calc.calculator(AUCKLAND))
    assert.deepStrictEqual(v, {
      'environment.tide.heightHigh': 2.6,
      'environment.tide.timeHigh': '2026-10-19T13:37:00.000Z',
      'environment.tide.heightLow': 1.1,
      'environment.tide.timeLow': '2026-10-19T19:40:00.000Z'
    })
    assert.deepStrictEqual(urls, ['https://static.charts.linz.govt.nz/tide-tables/maj-ports/csv/Auckland 2026.csv'])
    assert.ok(app.statuses[0].startsWith('LINZ Auckland (CD)'), app.statuses[0])
    state.now = '2026-11-30T10:00:00Z'
    await calc.calculator(AUCKLAND)
    assert.strictEqual(urls.length, 1)
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'CD')
    assert.strictEqual(f.station.name, 'Auckland')
  } finally {
    calc.stop()
  }
})

test('kept in the data folder: works offline after the first download', async () => {
  const first = setup()
  await first.calc.calculator(AUCKLAND)
  first.calc.stop()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(fs.existsSync(path.join(first.dataDir, 'linz', 'Auckland 2026.csv')))
  const second = setup({ dataDir: first.dataDir })
  try {
    assert.strictEqual(byPath(await second.calc.calculator(AUCKLAND))['environment.tide.heightHigh'], 2.6)
    assert.strictEqual(second.urls.length, 0)
  } finally {
    second.calc.stop()
  }
})

test('last week of December: next year too (missing here: reported, this year still used)', async () => {
  const { calc, urls, app } = setup({ now: '2026-12-27T00:00:00Z' })
  try {
    const v = byPath(await calc.calculator(AUCKLAND))
    assert.ok(urls.includes('https://static.charts.linz.govt.nz/tide-tables/maj-ports/csv/Auckland 2027.csv'))
    assert.ok(typeof v['environment.tide.heightHigh'] === 'number')
    assert.ok(app.pluginErrors.some(m => m.includes('no LINZ tide table for Auckland 2027')))
  } finally {
    calc.stop()
  }
})

test('ports: positions in New Zealand waters; far away: quiet', async () => {
  assert.strictEqual(linz.PORTS.length, 83)
  assert.ok(linz.PORTS.every(p => p.latitude < -29 && p.latitude > -53))
  assert.ok(!linz.PORTS.some(p => /Chatham/.test(p.name)))
  const far = setup()
  try {
    assert.strictEqual(await far.calc.calculator({ latitude: -40, longitude: 160 }), undefined)
    assert.deepStrictEqual(far.app.pluginErrors, [])
  } finally {
    far.calc.stop()
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
