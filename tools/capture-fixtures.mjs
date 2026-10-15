#!/usr/bin/env node
/*
 * Fetches real sample responses from the tide services the plugin uses, for the test fixtures.
 * Run from the repository folder (Node 18 or newer):
 *
 *   node tools/capture-fixtures.mjs
 *
 * Everything is saved in test/fixtures/captured/, with a summary in index.json (index-<sources>.json
 * when only some sources are asked for). Requests go one at a time with a pause between them; all
 * sources take a few minutes. Errors are saved too: they show what each service answers when
 * something is wrong.
 *
 * Only some sources:   node tools/capture-fixtures.mjs ireland germany ioc
 * Sources: smhi fmi rws chs openmeteo ireland germany admiralty ea ioc noaa linz
 *
 * The UK Admiralty API needs your own free key (https://admiralty.azure-api.net, "UK Tidal API -
 * Discovery"). It is sent in a header and never saved:
 *   ADMIRALTY_API_KEY=... node tools/capture-fixtures.mjs admiralty
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
      headers: Object.assign({ 'User-Agent': USER_AGENT }, options.body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : {}, options.headers),
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
  const ext = /json/.test(type) ? 'json' : /xml/.test(type) ? 'xml' : /csv/.test(type) ? 'csv' : /html/.test(type) ? 'html' : 'txt'
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
    // the request the provider sends
    await get(`openmeteo-${name}`, `${base}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=sea_level_height_msl,invert_barometer_height&past_days=1&forecast_days=7&timezone=GMT&timeformat=unixtime`)
  }
}

// --- Marine Institute (Ireland), ERDDAP --------------------------------------------------
async function ireland () {
  const base = 'https://erddap.marine.ie/erddap'
  const found = (await get('ireland-search-tide', `${base}/search/index.json?page=1&itemsPerPage=200&searchFor=tide`)).json()
  const table = found && found.table
  const col = table ? table.columnNames.indexOf('Dataset ID') : -1
  const ids = col >= 0 ? table.rows.map(r => r[col]).filter(id => /tide/i.test(id)) : []
  for (const id of ids.slice(0, 6)) {
    await get(`ireland-info-${id}`, `${base}/info/${id}/index.json`)
    // all variables, from 2 hours ago to a day ahead (observations end now, predictions go on)
    await get(`ireland-data-${id}`, `${base}/tabledap/${id}.json?&time>=now-2hours&time<=now%2B1day`)
  }
}

// --- PEGELONLINE (Germany, federal waterways) ---------------------------------------------
async function germany () {
  const base = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2'
  const list = (await get('germany-stations', `${base}/stations.json?includeTimeseries=true&includeCurrentMeasurement=true`)).json() || []
  const withW = list.filter(s => typeof s.latitude === 'number' && (s.timeseries || []).some(t => t.shortname === 'W'))
  for (const [name, lat, lon] of [['cuxhaven', 53.87, 8.72], ['kiel', 54.37, 10.15]]) {
    withW.sort((a, b) => distance({ lat, lon }, { lat: a.latitude, lon: a.longitude }) - distance({ lat, lon }, { lat: b.latitude, lon: b.longitude }))
    const s = withW[0]
    if (!s) continue
    await get(`germany-${name}-station`, `${base}/stations/${s.uuid}.json?includeTimeseries=true&includeCharacteristicValues=true`)
    await get(`germany-${name}-W`, `${base}/stations/${s.uuid}/W/measurements.json?start=P1D`)
    // any other series at that station (e.g. forecasts), a day of each
    for (const t of (s.timeseries || []).filter(t => t.shortname !== 'W').slice(0, 3)) {
      await get(`germany-${name}-${t.shortname}`, `${base}/stations/${s.uuid}/${encodeURIComponent(t.shortname)}/measurements.json?start=P1D`)
    }
  }
}

// --- UK Admiralty Tidal API (needs ADMIRALTY_API_KEY) ---------------------------------------
async function admiralty () {
  const key = process.env.ADMIRALTY_API_KEY
  if (!key) {
    console.log('   skipped: set ADMIRALTY_API_KEY to capture the Admiralty API')
    return
  }
  const base = 'https://admiraltyapi.azure-api.net/uktidalapi/api/V1'
  const headers = { 'Ocp-Apim-Subscription-Key': key }
  const list = (await get('admiralty-stations', `${base}/Stations`, { headers })).json()
  const features = (list && list.features) || []
  const near = { lat: 51.11, lon: 1.32 } // Dover
  features.sort((a, b) => {
    const pa = a.geometry.coordinates
    const pb = b.geometry.coordinates
    return distance(near, { lat: pa[1], lon: pa[0] }) - distance(near, { lat: pb[1], lon: pb[0] })
  })
  const s = features[0]
  if (!s) return
  const id = s.properties.Id
  await get(`admiralty-station-${id}`, `${base}/Stations/${id}`, { headers })
  await get(`admiralty-events-${id}`, `${base}/Stations/${id}/TidalEvents?duration=7`, { headers })
  await get('admiralty-events-unknown', `${base}/Stations/XXXX/TidalEvents?duration=7`, { headers })
}

// --- Environment Agency (England), flood monitoring: tide gauges ----------------------------
async function ea () {
  const base = 'https://environment.data.gov.uk/flood-monitoring'
  const list = (await get('ea-tide-gauges', `${base}/id/stations?type=TideGauge`)).json()
  const items = ((list && list.items) || []).filter(s => typeof s.lat === 'number')
  for (const [name, lat, lon] of [['dover', 51.11, 1.32], ['newlyn', 50.10, -5.54]]) {
    items.sort((a, b) => distance({ lat, lon }, { lat: a.lat, lon: a.long }) - distance({ lat, lon }, { lat: b.lat, lon: b.long }))
    const s = items[0]
    if (!s) continue
    await get(`ea-${name}-station`, `${base}/id/stations/${s.stationReference}`)
    await get(`ea-${name}-readings`, `${base}/id/stations/${s.stationReference}/readings?_sorted&_limit=100`)
  }
}

// --- IOC Sea Level Station Monitoring Facility (worldwide) -----------------------------------
async function ioc () {
  const base = 'https://www.ioc-sealevelmonitoring.org/service.php'
  const list = (await get('ioc-stations', `${base}?query=stationlist&showall=all`)).json() || []
  const items = (Array.isArray(list) ? list : []).filter(s => isFinite(Number(s.Lat)) && isFinite(Number(s.Lon)))
  for (const [name, lat, lon] of [['fredrikstad', 59.21, 10.95], ['reykjavik', 64.15, -21.94]]) {
    items.sort((a, b) => distance({ lat, lon }, { lat: Number(a.Lat), lon: Number(a.Lon) }) - distance({ lat, lon }, { lat: Number(b.Lat), lon: Number(b.Lon) }))
    // a water level sensor that reported in the last two days (the list has one row per sensor)
    const recent = items.filter(i => /^(rad|ra2|prs|prt|pr1|pr2|flt|bub|enc|pwl|wls|aqu)$/.test(i.sensor) &&
      Date.parse(String(i.lasttime).replace(' ', 'T') + 'Z') > now.getTime() - 2 * 24 * 3600e3)
    const s = recent[0]
    if (!s) continue
    // 'Invalid date provided' for ISO times with Z: try the forms the service may want
    const day = d => d.toISOString().slice(0, 19)
    const code = encodeURIComponent(s.Code)
    await get(`ioc-${name}-${s.Code}-a`, `${base}?query=data&code=${code}&timestart=${day(hours(-3))}&timestop=${day(now)}&format=json`)
    await get(`ioc-${name}-${s.Code}-b`, `${base}?query=data&code=${code}&timestart=${day(hours(-3)).replace('T', '%20')}&timestop=${day(now).replace('T', '%20')}&format=json`)
    await get(`ioc-${name}-${s.Code}-c`, `${base}?query=data&code=${code}&period=0.125&format=json`)
    await get(`ioc-${name}-${s.Code}-d`, `${base}?query=data&code=${code}&period=0.125&endtime=${day(now)}&format=json`)
  }
}

// --- NOAA CO-OPS (US): observations for the NOAA provider upgrade ---------------------------
async function noaa () {
  const meta = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi'
  const data = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
  const ymd = d => d.toISOString().slice(0, 16).replace(/-/g, '').replace('T', '%20')
  const q = (product, from, to, extra = '') =>
    `${data}?product=${product}&station=9414290&begin_date=${ymd(from)}&end_date=${ymd(to)}&datum=MLLW&units=metric&time_zone=gmt&format=json&application=signalk-tides-api${extra}`
  await get('noaa-stations-waterlevels', `${meta}/stations.json?type=waterlevels`)
  await get('noaa-9414290-water-level', q('water_level', hours(-2), now))
  await get('noaa-9414290-predictions-hilo', q('predictions', hours(-1), hours(7 * 24), '&interval=hilo'))
  await get('noaa-9414290-predictions-6min', q('predictions', hours(-1), hours(48), '&interval=6'))
  await get('noaa-unknown-station', q('water_level', hours(-2), now).replace('9414290', '1234567'))
}

// --- LINZ (New Zealand): yearly tide prediction tables --------------------------------------
async function linz () {
  const site = 'https://www.linz.govt.nz'
  const abs = l => l.startsWith('http') ? l : site + l
  const links = body => [...new Set((body.match(/href="([^"]+)"/gi) || []).map(h => h.slice(6, -1)))]
  // the standard ports are on the list view page, one file per port and year
  const list = await get('linz-list-view', `${site}/products-services/tides-and-tidal-streams/tide-predictions/tide-predictions-list-view`)
  const files = links(list.body).filter(l => /\.(csv|txt|xlsx?|pdf)(\?|$)/i.test(l))
  const pick = files.filter(l => /auckland|wellington/i.test(l) && /csv/i.test(l)).slice(0, 2)
  for (const [i, link] of (pick.length ? pick : files.filter(l => /csv/i.test(l)).slice(0, 2)).entries()) await get(`linz-port-${i + 1}`, abs(link))
  // harmonic constants (could be used to compute predictions on the boat)
  const constituents = await get('linz-constituents-page', `${site}/products-services/data/types-linz-data/sea-level-data/tide-constituents`)
  const data = links(constituents.body).filter(l => /\.(csv|txt|zip)(\?|$)/i.test(l)).slice(0, 1)
  for (const link of data) await get('linz-constituents', abs(link))
}

const SOURCES = {
  smhi: ['SMHI', smhi],
  fmi: ['FMI', fmi],
  rws: ['Rijkswaterstaat', rws],
  chs: ['CHS', chs],
  openmeteo: ['Open-Meteo', openMeteo],
  ireland: ['Marine Institute (Ireland)', ireland],
  germany: ['PEGELONLINE (Germany)', germany],
  admiralty: ['Admiralty (UK)', admiralty],
  ea: ['Environment Agency (England)', ea],
  ioc: ['IOC sea level monitoring', ioc],
  noaa: ['NOAA', noaa],
  linz: ['LINZ (New Zealand)', linz]
}
const asked = process.argv.slice(2)
const unknown = asked.filter(a => !SOURCES[a])
if (unknown.length) {
  console.log(`Unknown source: ${unknown.join(', ')}. Sources: ${Object.keys(SOURCES).join(' ')}`)
  process.exit(1)
}
for (const [label, run] of (asked.length ? asked : Object.keys(SOURCES)).map(k => SOURCES[k])) {
  console.log(`\n== ${label}`)
  try {
    await run()
  } catch (err) {
    console.log(`!! ${label} stopped: ${err.message}`)
    index.push({ name: label, status: 'script-error', error: String(err.message) })
  }
}
fs.writeFileSync(path.join(OUT, asked.length ? `index-${asked.join('-')}.json` : 'index.json'), JSON.stringify({ captured: now.toISOString(), node: process.version, requests: index }, null, 1))
console.log(`\nSaved ${index.length} responses in ${path.relative(process.cwd(), OUT)}`)
