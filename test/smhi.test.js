/*
 * Offline tests for calcs/smhi.js. Run with: node test/smhi.test.js
 * Fixtures are real SMHI responses for Kungsvik (station 2130), captured 2026-10-15T16:18Z and cut
 * down (links removed; the minute series cut to its last 60 values). Data: SMHI, CC BY 4.0.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const smhi = require('../calcs/smhi')

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const STROMSTAD = { latitude: 58.94, longitude: 11.17 } // 7 km from Kungsvik
const MOSS = { latitude: 59.43, longitude: 10.66 } // 56 km from Kungsvik

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function answer (url) {
  const u = new URL(url).pathname.replace('/api/version/1.0/', '')
  if (u === 'parameter/6.json') return fixture('smhi-parameter-6.json')
  if (u === 'parameter/12.json') return fixture('smhi-parameter-12.json')
  if (u === 'parameter/14/station/2130/period/latest-hour/data.json') return fixture('smhi-14-2130-latest-hour.json')
  if (u === 'parameter/6/station/2130/period/latest-day/data.json') return fixture('smhi-6-2130-latest-day.json')
  return new Error('HTTP 404: Not Found') // e.g. parameter 13, not captured
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T16:18:31Z', position: STROMSTAD }
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'smhi-'))
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
    urls.push(new URL(url).pathname.replace('/api/version/1.0/', ''))
    const a = opts.answer ? opts.answer(url) : answer(url)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ smhi: true }, opts.tides) } }
  const calc = smhi(app, plugin, { getJson })
  return { state, app, calc, urls, dataDir }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}

test('RH2000: falls back to hourly values where there are no minute values', async () => {
  const { calc, app, urls } = setup()
  try {
    const v = byPath(await calc.calculator(STROMSTAD))
    // latest hourly value 2026-10-15T14:00Z: 15.1 cm
    assert.deepStrictEqual(v, { 'environment.tide.heightObserved': 0.151, 'environment.tide.heightNow': 0.151 })
    assert.deepStrictEqual(urls, [
      'parameter/6.json',
      'parameter/13/station/2130/period/latest-hour/data.json',
      'parameter/6/station/2130/period/latest-day/data.json'
    ])
    assert.ok(app.statuses[0].startsWith('SMHI Kungsvik (RH2000), height now from measurement'), app.statuses[0])
    assert.deepStrictEqual(app.pluginErrors, [])
  } finally {
    calc.stop()
  }
})

test('MW: minute values relative to mean water level', async () => {
  const { calc, app, urls } = setup({ tides: { smhiDatum: 'MW' } })
  try {
    const v = byPath(await calc.calculator(STROMSTAD))
    // latest minute value 2026-10-15T14:58Z: 24.0 cm
    assert.deepStrictEqual(v, { 'environment.tide.heightObserved': 0.24, 'environment.tide.heightNow': 0.24 })
    assert.deepStrictEqual(urls, ['parameter/12.json', 'parameter/14/station/2130/period/latest-hour/data.json'])
    assert.ok(app.statuses[0].includes('(MW)'))
  } finally {
    calc.stop()
  }
})

test('caches: data at the refresh interval, the 404 remembered, one station list', async () => {
  const { calc, state, urls } = setup()
  try {
    await calc.calculator(STROMSTAD)
    state.now = '2026-10-15T16:27:00Z'
    await calc.calculator(STROMSTAD)
    assert.strictEqual(urls.length, 3)
    state.now = '2026-10-15T16:29:00Z'
    await calc.calculator(STROMSTAD)
    assert.deepStrictEqual(urls.slice(3), ['parameter/6/station/2130/period/latest-day/data.json'], 'straight to hourly values')
  } finally {
    calc.stop()
  }
})

test('an empty latest hour uses the hourly values without giving up on minute values', async () => {
  const { calc, state, urls } = setup({
    tides: { smhiDatum: 'MW' },
    answer: url => /\/14\/.*latest-hour/.test(url) ? { value: [] } : /\/12\/station\/2130\/period\/latest-day/.test(url)
      ? fixture('smhi-6-2130-latest-day.json') : answer(url)
  })
  try {
    const v = byPath(await calc.calculator(STROMSTAD))
    assert.strictEqual(v['environment.tide.heightNow'], 0.151)
    state.now = '2026-10-15T16:29:00Z'
    await calc.calculator(STROMSTAD)
    assert.strictEqual(urls.filter(u => u.includes('/14/')).length, 2)
  } finally {
    calc.stop()
  }
})

test('station choice: active stations that reported recently, within the distance limit', async () => {
  const far = setup()
  try {
    assert.strictEqual(await far.calc.calculator(MOSS), undefined, 'Kungsvik is 56 km away')
    assert.deepStrictEqual(far.app.pluginErrors, [])
  } finally {
    far.calc.stop()
  }
  const wider = setup({ tides: { smhiMaxDistanceKm: 60 } })
  wider.state.position = MOSS
  try {
    assert.strictEqual(byPath(await wider.calc.calculator(MOSS))['environment.tide.heightNow'], 0.151)
  } finally {
    wider.calc.stop()
  }
  // Malmö (2098, inactive since 1963) is 0.2 km closer than Malmö Hamn (35152): the latter is used
  const malmo = setup()
  try {
    await malmo.calc.calculator({ latitude: 55.6167, longitude: 13.0 })
    assert.ok(malmo.urls.some(u => u.includes('/station/35152/')), malmo.urls.join(' '))
    assert.ok(!malmo.urls.some(u => u.includes('/station/2098/')))
  } finally {
    malmo.calc.stop()
  }
})

test('old data is not published; no tides resource', async () => {
  const { calc, state } = setup()
  try {
    state.now = '2026-10-15T17:30:00Z' // 3.5 h after the latest hourly value
    assert.strictEqual(await calc.calculator(STROMSTAD), undefined)
    assert.strictEqual(calc.tideForecast, undefined)
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
