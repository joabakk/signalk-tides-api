/*
 * Offline tests for calcs/rws.js. Run with: node test/rws.test.js
 * Answers are generated here in the DD API 2.0 format (field names as used by working clients:
 * AquoMetadataLijst, AquoMetadataLocatieLijst, LocatieLijst; WaarnemingenLijst, MetingenLijst,
 * Tijdstip with +01:00, Meetwaarde.Waarde_Numeriek in cm, Waarde_Alfanumeriek hoogwater/laagwater).
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const rws = require('../calcs/rws')

const HOEK = { latitude: 51.98, longitude: 4.10 }
const LOBITH = { latitude: 51.85, longitude: 6.10 }
const AMSTERDAM = { latitude: 52.37, longitude: 4.90 }

const aquo = (id, procesType, grootheid, hoedanigheid, groepering) => ({
  AquoMetadata_MessageID: id,
  ProcesType: procesType,
  Grootheid: { Code: grootheid },
  Hoedanigheid: { Code: hoedanigheid },
  Groepering: { Code: groepering || '' },
  Eenheid: { Code: 'cm' }
})
const CATALOGUE = {
  Succesvol: true,
  AquoMetadataLijst: [
    aquo(1, 'astronomisch', 'WATHTE', 'NAP', 'GETETBRKD2'),
    aquo(2, 'meting', 'WATHTE', 'NAP'),
    aquo(3, 'verwachting', 'WATHTE', 'NAP'),
    aquo(4, 'astronomisch', 'WATHTE', 'NAP'),
    aquo(5, 'meting', 'WATHTE', 'MSL')
  ],
  AquoMetadataLocatieLijst: [
    { AquoMetaData_MessageID: 1, Locatie_MessageID: 10 },
    { AquoMetaData_MessageID: 2, Locatie_MessageID: 10 },
    { AquoMetaData_MessageID: 3, Locatie_MessageID: 10 },
    { AquoMetaData_MessageID: 4, Locatie_MessageID: 10 },
    { AquoMetaData_MessageID: 1, Locatie_MessageID: 11 },
    { AquoMetaData_MessageID: 4, Locatie_MessageID: 11 },
    { AquoMetaData_MessageID: 2, Locatie_MessageID: 12 },
    { AquoMetaData_MessageID: 5, Locatie_MessageID: 12 }
  ],
  LocatieLijst: [
    { Locatie_MessageID: 10, Code: 'hoekvanholland', Naam: 'Hoek van Holland', Lat: 51.9775, Lon: 4.1200 },
    { Locatie_MessageID: 11, Code: 'vlissingen', Naam: 'Vlissingen', Lat: 51.4423, Lon: 3.5960 },
    { Locatie_MessageID: 12, Code: 'lobith', Naam: 'Lobith', Lat: 51.8500, Lon: 6.1000 }
  ]
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Semidiurnal tide of ±0.9 m around 0.1 m NAP; measured 0.12 m and forecast 0.08 m above it.
const H0 = Date.UTC(2026, 9, 15, 6, 0)
const PERIOD = 12.42 * 3600e3
const tide = t => 0.1 + 0.9 * Math.cos(2 * Math.PI * (t - H0) / PERIOD)
const local = t => new Date(t + 3600e3).toISOString().replace('Z', '+01:00')

function list (meta, rows) {
  return { Locatie: { Code: 'x' }, AquoMetadata: meta, MetingenLijst: rows }
}
const cm = (t, v, quality) => ({
  Tijdstip: local(t),
  Meetwaarde: { Waarde_Numeriek: v },
  WaarnemingMetadata: { Kwaliteitswaardecode: quality || '00' }
})

function answer (url, body, overrides) {
  if (url.endsWith('/OphalenCatalogus')) return CATALOGUE
  const meta = body.AquoPlusWaarnemingMetadata.AquoMetadata
  const kind = meta.Groepering ? 'highLow' : meta.ProcesType
  if (overrides && overrides[kind] !== undefined) return overrides[kind]
  const from = Date.parse(body.Periode.Begindatumtijd)
  const to = Date.parse(body.Periode.Einddatumtijd)
  const hl = { ProcesType: 'astronomisch', Groepering: { Code: 'GETETBRKD2' }, Eenheid: { Code: 'cm' } }
  if (kind === 'highLow') {
    const times = []
    for (let k = -2; k < 20; k++) {
      const t = H0 + k * PERIOD / 2
      if (t >= from && t <= to) times.push({ t, high: k % 2 === 0 })
    }
    return {
      Succesvol: true,
      WaarnemingenLijst: [
        list(Object.assign({ Grootheid: { Code: 'NVT' }, Hoedanigheid: { Code: 'NVT' }, Typering: { Code: 'GETETTPE' } }, hl),
          times.map(x => ({ Tijdstip: local(x.t), Meetwaarde: { Waarde_Alfanumeriek: x.high ? 'hoogwater' : 'laagwater' } }))),
        list(Object.assign({ Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } }, hl),
          times.map(x => cm(x.t, Math.round(tide(x.t) * 100))))
      ]
    }
  }
  const offset = kind === 'meting' ? 0.12 : kind === 'verwachting' ? 0.08 : 0
  const rows = []
  for (let t = Math.ceil(from / 600e3) * 600e3; t <= to; t += 600e3) rows.push(cm(t, Math.round((tide(t) + offset) * 100)))
  if (kind === 'meting') rows.push(cm(Math.floor(to / 600e3) * 600e3 + 1, 999999999, '99'))
  const lists = [list({ ProcesType: kind, Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' }, Groepering: { Code: '' }, Eenheid: { Code: 'cm' } }, rows)]
  if (kind === 'astronomisch') {
    // the service also returns the high/low height series for this query: it must be ignored
    lists.unshift(list(Object.assign({ Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } }, hl), [cm(from, 500)]))
  }
  return { Succesvol: true, WaarnemingenLijst: lists }
}

function setup (opts) {
  opts = opts || {}
  const state = { now: '2026-10-15T10:07:00Z', position: HOEK }
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rws-'))
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
  const requests = []
  const postJson = (url, body) => {
    requests.push({ url, body })
    const a = answer(url, body, opts.overrides)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  const plugin = { id: 'tides-api', properties: { tides: Object.assign({ rws: true }, opts.tides) } }
  const calc = rws(app, plugin, { postJson })
  const kindOf = r => r.url.endsWith('/OphalenCatalogus') ? 'catalogue'
    : r.body.AquoPlusWaarnemingMetadata.AquoMetadata.Groepering ? 'highLow'
      : r.body.AquoPlusWaarnemingMetadata.AquoMetadata.ProcesType
  const of = kind => requests.filter(r => kindOf(r) === kind)
  return { state, app, calc, requests, of, kindOf, dataDir }
}

const byPath = values => {
  const out = {}
  ;(values || []).forEach(v => { out[v.path] = v.value })
  return out
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

test('publishes highs and lows, astronomical, measured and forecast levels', async () => {
  const { calc, app } = setup()
  try {
    const v = byPath(await calc.calculator(HOEK))
    // the next low after 10:07 is at 06:00 + 6.21 h = 12:12:36, then a high at 18:25:12
    assert.strictEqual(v['environment.tide.timeLow'], '2026-10-15T12:12:36.000Z')
    assert.strictEqual(v['environment.tide.heightLow'], -0.8)
    assert.strictEqual(v['environment.tide.timeHigh'], '2026-10-15T18:25:12.000Z')
    assert.strictEqual(v['environment.tide.heightHigh'], 1)
    const now = Date.parse('2026-10-15T10:07:00Z')
    assert.ok(near(v['environment.tide.heightPredicted'], tide(now), 0.03), `predicted ${v['environment.tide.heightPredicted']}`)
    // the latest good measurement (10:00), not the quality-99 gap value after it
    assert.ok(near(v['environment.tide.heightObserved'], tide(Date.parse('2026-10-15T10:00:00Z')) + 0.12, 0.006))
    assert.ok(near(v['environment.tide.heightForecast'], tide(now) + 0.08, 0.03))
    assert.strictEqual(v['environment.tide.heightNow'], v['environment.tide.heightObserved'])
    assert.ok(near(v['environment.tide.weatherEffect'], 0.12, 0.02), `weatherEffect ${v['environment.tide.weatherEffect']}`)
    assert.ok(app.statuses[0].includes('Rijkswaterstaat Hoek van Holland (NAP), height now from measurement'), app.statuses[0])
    assert.ok(app.statuses[0].includes('CC0'))
  } finally {
    calc.stop()
  }
})

test('sends the expected requests, one catalogue', async () => {
  const { calc, requests, kindOf } = setup()
  try {
    await calc.calculator(HOEK)
    assert.deepStrictEqual(requests.map(kindOf), ['catalogue', 'highLow', 'astronomisch', 'meting', 'verwachting'])
    assert.strictEqual(requests[0].url, 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus')
    assert.deepStrictEqual(requests[0].body, { CatalogusFilter: { Grootheden: true, Groeperingen: true, Hoedanigheden: true, ProcesTypes: true } })
    assert.strictEqual(requests[1].url, 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen')
    assert.deepStrictEqual(requests[1].body, {
      Locatie: { Code: 'hoekvanholland' },
      AquoPlusWaarnemingMetadata: { AquoMetadata: { ProcesType: 'astronomisch', Groepering: { Code: 'GETETBRKD2' } } },
      Periode: { Begindatumtijd: '2026-10-15T09:07:00.000+00:00', Einddatumtijd: '2026-10-22T10:07:00.000+00:00' }
    })
    assert.deepStrictEqual(requests[3].body.AquoPlusWaarnemingMetadata.AquoMetadata,
      { ProcesType: 'meting', Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } })
  } finally {
    calc.stop()
  }
})

test('caches: measured every 10 min, forecast hourly, predictions when they run out', async () => {
  const { calc, state, of, requests } = setup()
  try {
    await calc.calculator(HOEK)
    state.now = '2026-10-15T10:16:00Z'
    await calc.calculator(HOEK)
    assert.strictEqual(requests.length, 5)
    state.now = '2026-10-15T10:17:00Z'
    await calc.calculator(HOEK)
    assert.strictEqual(of('meting').length, 2)
    assert.strictEqual(of('verwachting').length, 1)
    state.now = '2026-10-15T11:07:00Z'
    await calc.calculator(HOEK)
    assert.strictEqual(of('verwachting').length, 2)
    state.now = '2026-10-17T04:10:00Z' // the 2-day series ends 10-17T10:00: asked again 6 h before
    await calc.calculator(HOEK)
    assert.strictEqual(of('astronomisch').length, 2)
    assert.strictEqual(of('highLow').length, 1)
    assert.strictEqual(of('catalogue').length, 1)
  } finally {
    calc.stop()
  }
})

test('station choice: needs high and low waters, within the distance limit', async () => {
  const river = setup()
  river.state.position = LOBITH
  try {
    assert.strictEqual(await river.calc.calculator(LOBITH), undefined, 'Lobith has no tide predictions')
    assert.deepStrictEqual(river.app.pluginErrors, [])
  } finally {
    river.calc.stop()
  }
  const zeeland = setup()
  try {
    await zeeland.calc.calculator({ latitude: 51.44, longitude: 3.58 })
    assert.strictEqual(zeeland.requests[1].body.Locatie.Code, 'vlissingen')
    assert.strictEqual(zeeland.of('meting').length, 0, 'no measured series listed there')
    assert.strictEqual(zeeland.of('verwachting').length, 0)
  } finally {
    zeeland.calc.stop()
  }
  const far = setup({ tides: { rwsMaxDistanceKm: 10 } })
  try {
    assert.strictEqual(await far.calc.calculator(AMSTERDAM), undefined)
  } finally {
    far.calc.stop()
  }
})

test('an empty period (204) and an unsuccessful answer', async () => {
  const empty = setup({ overrides: { verwachting: null } })
  try {
    const v = byPath(await empty.calc.calculator(HOEK))
    assert.ok(typeof v['environment.tide.heightNow'] === 'number')
    assert.strictEqual(v['environment.tide.heightForecast'], undefined)
    assert.deepStrictEqual(empty.app.pluginErrors, [])
  } finally {
    empty.calc.stop()
  }
  const failed = setup({ overrides: { highLow: { Succesvol: false, Foutmelding: 'Geen gegevens gevonden' } } })
  try {
    const v = byPath(await failed.calc.calculator(HOEK))
    assert.ok(failed.app.pluginErrors.some(m => m.includes('Geen gegevens gevonden')), failed.app.pluginErrors.join('; '))
    // extremes then come from the astronomical series
    assert.ok(near(new Date(v['environment.tide.timeLow']) - Date.parse('2026-10-15T12:12:36Z'), 0, 10 * 60e3), v['environment.tide.timeLow'])
  } finally {
    failed.calc.stop()
  }
})

test('the catalogue is kept in a file', async () => {
  const first = setup()
  await first.calc.calculator(HOEK)
  first.calc.stop()
  await new Promise(resolve => setTimeout(resolve, 30))
  const second = setup({ dataDir: first.dataDir })
  try {
    await second.calc.calculator(HOEK)
    assert.strictEqual(second.of('catalogue').length, 0)
  } finally {
    second.calc.stop()
  }
})

test('tides resource', async () => {
  const { calc } = setup()
  try {
    const f = await calc.tideForecast()
    assert.strictEqual(f.datum, 'NAP')
    assert.deepStrictEqual(f.station, { id: 'rws/hoekvanholland', name: 'Hoek van Holland', latitude: 51.9775, longitude: 4.12 })
    assert.deepStrictEqual(f.extremes[0], { time: '2026-10-15T12:12:36.000Z', level: -0.8, high: false, low: true, label: 'Low' })
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
