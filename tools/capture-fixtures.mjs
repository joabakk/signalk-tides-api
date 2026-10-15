#!/usr/bin/env node
/*
 * Fetches real sample responses from the tide services the plugin uses, for the test fixtures.
 * Run from the repository folder (Node 18 or newer):
 *
 *   node tools/capture-fixtures.mjs
 *
 * Everything is saved in test/fixtures/captured/, with a summary in index.json. It makes about 25
 * requests, one at a time with a pause between them, and takes a minute or two. Errors are saved
 * too: they show what each service answers when something is wrong.
 */
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.join(process.cwd(), 'test', 'fixtures', 'captured')
const USER_AGENT = 'signalk-tides-api fixture capture (+https://github.com/joabakk/signalk-tides-api)'
const PAUSE_MS = 2500 // CHS allows 30 requests a minute; the others ask for moderate use
const index = []

fs.mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
const now = new Date()
const hours = h => new Date(now.getTime() + h * 3600e3)

async function get (name, url, options = {}) {
  await sleep(PAUSE_MS)
  const started = Date.now()
  let status, type, body
  try {
    const res = await fetch(url, {
      method: options.body ? 'POST' : 'GET',
      headers: Object.assign({ 'User-Agent': USER_AGENT }, options.body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : {}),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(60000)
    })
    status = res.status
    type = res.headers.get('content-type') || ''
    body = await res.text()
  } catch (err) {
    status = 'error'
    body = String(err && err.message)
  }
  const ext = /json/.test(type) ? 'json' : /xml/.test(type) ? 'xml' : 'txt'
  const file = `${name}.${ext}`
  fs.writeFileSync(path.join(OUT, file), body)
  index.push({ name, file, url, method: options.body ? 'POST' : 'GET', request: options.body, status, contentType: type, bytes: body.length, ms: Date.now() - started })
  console.log(`${String(status).padEnd(5)} ${String(body.length).padStart(8)} B  ${name}`)
  return { status, body, json: () => { try { return JSON.parse(body) } catch (e) { return null } } }
}

function distance (a, b) {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return 6371 * Math.hypot(x, y)
}

// --- SMHI (Sweden): oceanographic observations ------------------------------------------
async function smhi () {
  const base = 'https://opendata-download-ocobs.smhi.se/api/version/1.0'
  const version = (await get('smhi-version', `${base}.json`)).json()
  const params = ((version && version.resource) || []).filter(p => /vattenst|sea level|water level/i.test(`${p.title} ${p.summary}`))
  const near = { lat: 58.94, lon: 11.17 } // Strömstad, across from Fredrikstad
  for (const p of params.slice(0, 3)) {
    const list = (await get(`smhi-parameter-${p.key}`, `${base}/parameter/${p.key}.json`)).json()
    const stations = ((list && list.station) || []).filter(s => s.active !== false)
    stations.sort((a, b) => distance(near, { lat: a.latitude, lon: a.longitude }) - distance(near, { lat: b.latitude, lon: b.longitude }))
    const s = stations[0]
    if (!s) continue
    await get(`smhi-parameter-${p.key}-station-${s.key}`, `${base}/parameter/${p.key}/station/${s.key}.json`)
    await get(`smhi-parameter-${p.key}-station-${s.key}-latest-day`, `${base}/parameter/${p.key}/station/${s.key}/period/latest-day/data.json`)
  }
}

// --- FMI (Finland): sea level forecast and mareograph observations -----------------------
async function fmi () {
  const wfs = 'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0'
  await get('fmi-describe-sealevel-forecast', `${wfs}&request=describeStoredQueries&storedquery_id=fmi::forecast::sealevel::point::simple`)
  await get('fmi-describe-mareograph', `${wfs}&request=describeStoredQueries&storedquery_id=fmi::observations::mareograph::simple`)
  await get('fmi-forecast-helsinki', `${wfs}&request=getFeature&storedquery_id=fmi::forecast::sealevel::point::simple&latlon=60.15,24.95&starttime=${iso(hours(-1))}&endtime=${iso(hours(48))}`)
  await get('fmi-stations-mareograph', `${wfs}&request=getFeature&storedquery_id=fmi::ef::stations&networkid=128`)
  await get('fmi-mareograph-no-station', `${wfs}&request=getFeature&storedquery_id=fmi::observations::mareograph::simple&parameters=watlev&starttime=${iso(hours(-1))}&endtime=${iso(now)}`)
  await get('fmi-mareograph-kaivopuisto', `${wfs}&request=getFeature&storedquery_id=fmi::observations::mareograph::simple&fmisid=132310&parameters=watlev&starttime=${iso(hours(-2))}&endtime=${iso(now)}`)
}

// --- Rijkswaterstaat (Netherlands) --------------------------------------------------------
async function rws () {
  const base = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl'
  const period = (from, to) => ({ Begindatumtijd: from.toISOString().replace('Z', '+00:00'), Einddatumtijd: to.toISOString().replace('Z', '+00:00') })
  await get('rws-catalogue', `${base}/METADATASERVICES/OphalenCatalogus`, {
    body: { CatalogusFilter: { Grootheden: true, Groeperingen: true, Hoedanigheden: true, ProcesTypes: true } }
  })
  await get('rws-highlow-hoekvanholland', `${base}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, {
    body: { Locatie: { Code: 'hoekvanholland' }, AquoPlusWaarnemingMetadata: { AquoMetadata: { ProcesType: 'astronomisch', Groepering: { Code: 'GETETBRKD2' } } }, Periode: period(hours(-1), hours(7 * 24)) }
  })
  await get('rws-astronomical-hoekvanholland', `${base}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, {
    body: { Locatie: { Code: 'hoekvanholland' }, AquoPlusWaarnemingMetadata: { AquoMetadata: { ProcesType: 'astronomisch', Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } } }, Periode: period(hours(-1), hours(48)) }
  })
  await get('rws-measured-hoekvanholland', `${base}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, {
    body: { Locatie: { Code: 'hoekvanholland' }, AquoPlusWaarnemingMetadata: { AquoMetadata: { ProcesType: 'meting', Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } } }, Periode: period(hours(-2), now) }
  })
  await get('rws-forecast-hoekvanholland', `${base}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, {
    body: { Locatie: { Code: 'hoekvanholland' }, AquoPlusWaarnemingMetadata: { AquoMetadata: { ProcesType: 'verwachting', Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } } }, Periode: period(now, hours(48)) }
  })
}

// --- CHS IWLS (Canada) --------------------------------------------------------------------
async function chs () {
  const base = 'https://api-iwls.dfo-mpo.gc.ca/api/v1'
  const list = (await get('chs-stations', `${base}/stations`)).json() || []
  const near = { lat: 48.42, lon: -123.37 } // Victoria, BC
  const codes = s => (s.timeSeries || []).map(t => t.code)
  const candidates = list.filter(s => ['wlp-hilo', 'wlp', 'wlo'].every(c => codes(s).includes(c)))
  candidates.sort((a, b) => distance(near, { lat: a.latitude, lon: a.longitude }) - distance(near, { lat: b.latitude, lon: b.longitude }))
  const s = candidates[0]
  if (!s) return
  await get(`chs-station-${s.code}`, `${base}/stations/${s.id}/metadata`)
  await get(`chs-${s.code}-wlp-hilo`, `${base}/stations/${s.id}/data?time-series-code=wlp-hilo&from=${iso(hours(-1))}&to=${iso(hours(7 * 24))}`)
  await get(`chs-${s.code}-wlp`, `${base}/stations/${s.id}/data?time-series-code=wlp&from=${iso(hours(-1))}&to=${iso(hours(48))}`)
  await get(`chs-${s.code}-wlo`, `${base}/stations/${s.id}/data?time-series-code=wlo&from=${iso(hours(-2))}&to=${iso(now)}`)
  if (codes(s).includes('wlf')) {
    await get(`chs-${s.code}-wlf`, `${base}/stations/${s.id}/data?time-series-code=wlf&from=${iso(now)}&to=${iso(hours(48))}`)
  }
}

// --- Open-Meteo marine (worldwide model) ----------------------------------------------------
async function openMeteo () {
  const base = 'https://marine-api.open-meteo.com/v1/marine'
  for (const [name, lat, lon] of [['fredrikstad', 59.21, 10.95], ['esbjerg', 55.46, 8.44], ['far-inland', 61.0, 9.0]]) {
    await get(`openmeteo-${name}`, `${base}?latitude=${lat}&longitude=${lon}&hourly=sea_level_height_msl,invert_barometer_height&past_days=1&forecast_days=3&timezone=GMT&cell_selection=sea`)
  }
}

for (const [label, run] of [['SMHI', smhi], ['FMI', fmi], ['Rijkswaterstaat', rws], ['CHS', chs], ['Open-Meteo', openMeteo]]) {
  console.log(`\n== ${label}`)
  try {
    await run()
  } catch (err) {
    console.log(`!! ${label} stopped: ${err.message}`)
    index.push({ name: label, status: 'script-error', error: String(err.message) })
  }
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ captured: now.toISOString(), node: process.version, requests: index }, null, 1))
console.log(`\nSaved ${index.length} responses in ${path.relative(process.cwd(), OUT)}`)
