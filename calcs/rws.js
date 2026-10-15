/*
 * Rijkswaterstaat (Netherlands) WaterWebservices, DD API 2.0 (POST with a JSON body, no key):
 * https://rijkswaterstaatdata.nl/waterdata
 *
 *   METADATASERVICES/OphalenCatalogus            catalogue: locations and the series they have
 *   ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen  values for one location, series and period
 *
 * Series (AquoMetadata) used:
 *   high and low waters   ProcesType astronomisch, Groepering GETETBRKD2: two series in one
 *                         answer, the type (hoogwater/laagwater) and the height (WATHTE, cm, NAP)
 *   astronomical tide     ProcesType astronomisch, Grootheid WATHTE, Hoedanigheid NAP
 *   measured water level  ProcesType meting, Grootheid WATHTE, Hoedanigheid NAP
 *   forecast water level  ProcesType verwachting, Grootheid WATHTE, Hoedanigheid NAP
 * Heights are in cm above NAP (the Dutch land datum), not chart datum. Times carry +01:00 all
 * year; they are read as the instants they state. Content CC0; RWS asks for fair use and says
 * the service has no uptime guarantee and is not for critical applications.
 *
 * Requests: the catalogue once a month (kept in a file), highs and lows for 7 days and the
 * astronomical tide for 2 days only when they run out, the measured level at the refresh interval
 * (default 10 min) and the forecast hourly. All four requests and the catalogue were checked
 * against real responses (test/fixtures/rws-live-*.json).
 */

const createProvider = require('../lib/tide-provider')
const { http, noData, quiet, nearest, stationList, HOUR, DAY } = createProvider

const DEFAULT_API_URL = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl'
const STATIONS_MAX_AGE = 30 * DAY
const HIGH_LOW = { hoogwater: 'high', laagwater: 'low' }
const GAP_QUALITY = '99'
const MAX_HEIGHT_CM = 10000

const code = (o, key) => o && o[key] && o[key].Code

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const postJson = deps.postJson || http.postJson

  function apiUrl (ctx) {
    return (ctx.options.rwsApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function apiTime (t) {
    return new Date(t).toISOString().replace('Z', '+00:00')
  }

  // Locations with astronomical high and low waters vs NAP, and which other series they have.
  function readCatalogue (body) {
    if (!body || body.Succesvol !== true) throw new Error('catalogue not usable')
    const metadata = body.AquoMetadataLijst || []
    const links = body.AquoMetadataLocatieLijst || []
    const locations = body.LocatieLijst || []
    const isHeight = m => code(m, 'Grootheid') === 'WATHTE' && code(m, 'Hoedanigheid') === 'NAP'
    const kinds = {}
    for (const m of metadata) {
      let kind = null
      if (m.ProcesType === 'astronomisch' && code(m, 'Groepering') === 'GETETBRKD2' && isHeight(m)) kind = 'highLow'
      // measured and forecast: the continuous series only, not grouped ones such as measured
      // extremes (GETETM2) or monthly extremes (EXTMWTHTE2)
      else if (m.ProcesType === 'meting' && isHeight(m) && !code(m, 'Groepering')) kind = 'measured'
      else if (m.ProcesType === 'verwachting' && isHeight(m) && !code(m, 'Groepering')) kind = 'forecast'
      if (kind) kinds[m.AquoMetadata_MessageID] = kind
    }
    const has = {}
    for (const l of links) {
      const kind = kinds[l.AquoMetaData_MessageID]
      if (!kind) continue
      const h = has[l.Locatie_MessageID] || (has[l.Locatie_MessageID] = {})
      h[kind] = true
    }
    const seen = new Set()
    const stations = []
    for (const l of locations) {
      const h = has[l.Locatie_MessageID]
      const lat = Number(l.Lat)
      const lon = Number(l.Lon)
      if (!h || !h.highLow || !l.Code || !isFinite(lat) || !isFinite(lon) || seen.has(l.Code)) continue
      seen.add(l.Code)
      stations.push({ id: l.Code, name: String(l.Naam || l.Code), latitude: lat, longitude: lon, measured: !!h.measured, forecast: !!h.forecast })
    }
    return stations
  }

  function observations (ctx, station, aquo, from, to) {
    const body = {
      Locatie: { Code: station.id },
      AquoPlusWaarnemingMetadata: { AquoMetadata: aquo },
      Periode: { Begindatumtijd: apiTime(from), Einddatumtijd: apiTime(to) }
    }
    ctx.debug(`POST OphalenWaarnemingen ${JSON.stringify(body)}`)
    return postJson(`${apiUrl(ctx)}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, body).then(answer => {
      // 204 No Content (no body) when there is nothing in the period
      if (answer === null) return []
      if (answer.Succesvol !== true || !Array.isArray(answer.WaarnemingenLijst)) {
        throw new Error(String(answer.Foutmelding || 'answer not usable').slice(0, 200))
      }
      return answer.WaarnemingenLijst
    })
  }

  function heights (list) {
    return (list.MetingenLijst || []).map(m => {
      const v = m && m.Meetwaarde && m.Meetwaarde.Waarde_Numeriek
      const time = new Date(m && m.Tijdstip)
      const quality = m && m.WaarnemingMetadata && m.WaarnemingMetadata.Kwaliteitswaardecode
      if (typeof v !== 'number' || Math.abs(v) >= MAX_HEIGHT_CM || quality === GAP_QUALITY || isNaN(time.getTime())) return null
      return { time, value: v / 100 }
    }).filter(Boolean).sort((a, b) => a.time - b.time)
  }

  function heightSeries (lists) {
    return lists.find(l => code(l.AquoMetadata, 'Grootheid') === 'WATHTE' && code(l.AquoMetadata, 'Hoedanigheid') === 'NAP' &&
      (!code(l.AquoMetadata, 'Eenheid') || code(l.AquoMetadata, 'Eenheid') === 'cm'))
  }

  function readHighLow (lists) {
    const types = lists.find(l => (l.MetingenLijst || []).some(m => m && m.Meetwaarde && HIGH_LOW[String(m.Meetwaarde.Waarde_Alfanumeriek).trim().toLowerCase()]))
    const level = heightSeries(lists)
    if (!types || !level) return []
    const byTime = new Map(heights(level).map(p => [p.time.getTime(), p.value]))
    return (types.MetingenLijst || []).map(m => {
      const flag = HIGH_LOW[String(m.Meetwaarde && m.Meetwaarde.Waarde_Alfanumeriek).trim().toLowerCase()]
      const time = new Date(m.Tijdstip)
      const value = byTime.get(time.getTime())
      return flag && value !== undefined ? { time, value, flag } : null
    }).filter(Boolean).sort((a, b) => a.time - b.time)
  }

  // A continuous series: the WATHTE/NAP series without the high/low grouping.
  function readLevels (lists) {
    const level = lists.find(l => code(l.AquoMetadata, 'Grootheid') === 'WATHTE' && code(l.AquoMetadata, 'Hoedanigheid') === 'NAP' &&
      !['GETETBRKD2', 'GETETBRKDMSL2'].includes(code(l.AquoMetadata, 'Groepering')))
    return level ? heights(level) : []
  }

  function plan (ctx) {
    const list = ctx.state['stations:rws-stations']
    if (!list) return
    const maxKm = Number(ctx.options.rwsMaxDistanceKm)
    const maxDistance = (isFinite(maxKm) && maxKm > 0 ? maxKm : 30) * 1000
    const found = nearest(list.stations, ctx.position)
    if (!found || found.distance > maxDistance) {
      ctx.state.station = undefined
      throw quiet(`no Rijkswaterstaat tide gauge within ${maxDistance / 1000} km`)
    }
    const station = ctx.state.station = found.item
    const s = ctx.state
    const t = ctx.t
    const mine = key => s[key] && s[key].stationId === station.id ? s[key] : null
    const lastTime = d => d && d.points.length ? d.points[d.points.length - 1].time.getTime() : 0
    const height = { Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } }

    if (lastTime(mine('extremes')) - t < DAY) {
      ctx.job('extremes', 'high and low waters', () => observations(ctx, station,
        { ProcesType: 'astronomisch', Groepering: { Code: 'GETETBRKD2' } }, t - HOUR, t + 7 * DAY).then(lists => {
        const points = readHighLow(lists)
        if (points.length === 0) throw noData(`no high and low waters for ${station.name}`)
        s.extremes = { stationId: station.id, points }
      }))
    }
    if (lastTime(mine('predicted')) - t < 6 * HOUR) {
      ctx.job('predicted', 'astronomical tide', () => observations(ctx, station,
        Object.assign({ ProcesType: 'astronomisch' }, height), t - HOUR, t + 2 * DAY).then(lists => {
        const points = readLevels(lists)
        if (points.length === 0) throw noData(`no astronomical tide series for ${station.name}`)
        s.predicted = { stationId: station.id, points }
      }))
    }
    const observed = mine('observed')
    if (station.measured && (!observed || t - observed.fetchedAt >= ctx.refreshMs)) {
      ctx.job('observed', 'measured water level', () => observations(ctx, station,
        Object.assign({ ProcesType: 'meting' }, height), t - HOUR, t).then(lists => {
        s.observed = { stationId: station.id, points: readLevels(lists), fetchedAt: t }
      }))
    }
    const forecast = mine('forecast')
    if (station.forecast && (!forecast || t - forecast.fetchedAt >= HOUR)) {
      ctx.job('forecast', 'forecast water level', () => observations(ctx, station,
        Object.assign({ ProcesType: 'verwachting' }, height), t - HOUR, t + 2 * DAY).then(lists => {
        s.forecast = { stationId: station.id, points: readLevels(lists), fetchedAt: t }
      }))
    }
  }

  const spec = {
    optionKey: 'rws',
    title: 'Rijkswaterstaat (Netherlands)',
    name: 'Rijkswaterstaat',
    attribution: 'Rijkswaterstaat WaterWebservices (CC0); heights above NAP, not chart datum; not for critical applications',
    refreshKey: 'rwsRefreshMinutes',
    defaultRefreshMinutes: 10,
    minRefreshMinutes: 10,
    maxObservationAgeMinutes: 60,
    properties: {
      rwsRefreshMinutes: {
        type: 'number',
        title: 'Rijkswaterstaat: minutes between measured water level updates (minimum 10)',
        default: 10
      },
      rwsMaxDistanceKm: {
        type: 'number',
        title: 'Rijkswaterstaat: use the nearest tide gauge within this distance (km)',
        default: 30
      },
      rwsApiUrl: {
        type: 'string',
        title: 'Rijkswaterstaat: API address',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const list = stationList(ctx, 'rws-stations', STATIONS_MAX_AGE, () => {
        ctx.debug('POST OphalenCatalogus')
        return postJson(`${apiUrl(ctx)}/METADATASERVICES/OphalenCatalogus`, {
          CatalogusFilter: { Grootheden: true, Groeperingen: true, Hoedanigheden: true, ProcesTypes: true }
        }).then(readCatalogue)
      })
      if (list) plan(ctx)
      else ctx.job('plan', 'station', () => plan(ctx))
    },
    view (ctx) {
      const station = ctx.state.station
      if (!station) return null
      const mine = key => ctx.state[key] && ctx.state[key].stationId === station.id ? ctx.state[key].points : undefined
      return {
        station: { id: station.id, name: station.name, latitude: station.latitude, longitude: station.longitude },
        datum: 'NAP',
        extremes: mine('extremes'),
        predicted: mine('predicted'),
        observed: mine('observed'),
        forecast: mine('forecast')
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
