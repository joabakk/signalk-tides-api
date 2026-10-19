/*
 * LINZ (Land Information New Zealand) tide predictions: one CSV file per port and year,
 * https://static.charts.linz.govt.nz/tide-tables/maj-ports/csv/<Port> <Year>.csv (no key)
 *
 *   line 1   number, port name, latitude and longitude (36°51'S,174°46'E)
 *   then     day, weekday, month, year, and up to four pairs of time (local standard or daylight
 *            time, Pacific/Auckland) and height (m above chart datum), alternating high and low
 *
 * High and low waters only. A port's file is downloaded once a year (and next year's in the last
 * week of December) and kept in the plugin's data folder, so it works offline for the rest of the
 * year. Data: LINZ, CC BY 4.0.
 *
 * The ports below are LINZ's list of ports with daily predictions; positions are from LINZ's
 * secondary ports table (to the minute; Dunedin's is approximate), replaced by the file's own
 * once it is downloaded. The Chatham Islands ports are left out: their times may be in Chatham
 * time, 45 minutes ahead of New Zealand's.
 */

const fs = require('fs')
const path = require('path')
const createProvider = require('../lib/tide-provider')
const { http, noData, quiet, nearest, maxDistance: maxDistanceOption, DAY } = createProvider

const DEFAULT_API_URL = 'https://static.charts.linz.govt.nz/tide-tables/maj-ports/csv'
const TIME_ZONE = 'Pacific/Auckland'

const PORTS = [
  ['Akaroa', -43.8, 172.9667],
  ['Anakakata Bay', -41.05, 174.2833],
  ['Anawhata', -36.9333, 174.45],
  ['Auckland', -36.85, 174.7667],
  ['Ben Gunn Wharf', -35.0, 173.2667],
  ['Bluff', -46.6, 168.35],
  ['Castlepoint', -40.9167, 176.2167],
  ['Charleston', -41.9, 171.4333],
  ['Dargaville', -35.9333, 173.8667],
  ['Deep Cove', -45.4667, 167.15],
  ['Dog Island', -46.65, 168.4167],
  ['Dunedin', -45.8833, 170.5167],
  ['Elaine Bay', -41.05, 173.7667],
  ['Elie Bay', -41.1333, 173.9833],
  ['Fishing Rock - Raoul Island', -29.25, -177.9167],
  ['Flour Cask Bay', -47.2833, 167.4833],
  ['Fresh Water Basin', -44.6667, 167.9333],
  ['Gisborne', -38.6667, 178.0333],
  ['Green Island', -45.95, 170.3833],
  ['Halfmoon Bay - Oban', -46.9, 168.1333],
  ['Havelock', -41.2833, 173.7667],
  ['Helensville', -36.6667, 174.45],
  ['Huruhi Harbour', -36.6, 175.7667],
  ['Jackson Bay', -43.9667, 168.6167],
  ['Kaikōura', -42.4167, 173.7],
  ['Kaiteriteri', -41.05, 173.0167],
  ['Kaituna River Entrance', -37.75, 176.4167],
  ['Kawhia', -38.0667, 174.8167],
  ['Korotiti Bay', -36.1833, 175.4833],
  ['Leigh', -36.2833, 174.8],
  ['Long Island', -41.1167, 174.2833],
  ['Lottin Point - Wakatiri', -37.55, 178.1667],
  ['Lyttelton', -43.6, 172.7167],
  ['Man o‘War Bay', -36.7833, 175.15],
  ['Mana Marina', -41.1, 174.8667],
  ['Manu Bay', -37.8167, 174.8167],
  ['Marsden Point', -35.8333, 174.5],
  ['Motuara Island', -41.1, 174.2667],
  ['Moturiki Island', -37.6333, 176.1833],
  ['Māpua', -41.25, 173.1],
  ['Mātiatia Bay', -36.7833, 174.9833],
  ['Napier', -39.4833, 176.9167],
  ['Nelson', -41.2667, 173.2667],
  ['New Brighton Pier', -43.5, 172.7333],
  ['North Cape - Otou', -34.4167, 173.05],
  ['Oamaru', -45.1, 170.9833],
  ['Omaha Bridge', -36.3333, 174.7667],
  ['Onehunga', -36.9333, 174.7833],
  ['Opononi', -35.5, 173.4],
  ['Opua', -35.3167, 174.1167],
  ['Paratutae Island', -37.05, 174.5167],
  ['Picton', -41.2833, 174.0],
  ['Port Chalmers', -45.8167, 170.65],
  ['Port Taranaki', -39.05, 174.0333],
  ['Port Ōhope Wharf', -37.9833, 177.1],
  ['Pouto Point', -36.3667, 174.1833],
  ['Raglan', -37.8, 174.8833],
  ['Rangatira Point', -40.85, 174.9333],
  ['Rangitaiki River Entrance', -37.9167, 176.8667],
  ['Richmond Bay', -41.0167, 173.9833],
  ['Riverton - Aparima', -46.3667, 168.0167],
  ['Spit Wharf', -45.7833, 170.7167],
  ['Sumner Head', -43.5667, 172.7667],
  ['Tarakohe', -40.8167, 172.9],
  ['Tauranga', -37.65, 176.1833],
  ['Thames', -37.1333, 175.5167],
  ['Timaru', -44.3833, 171.25],
  ['Town Basin', -35.7167, 174.3333],
  ['Tāmaki River', -36.9167, 174.8667],
  ['Waihopai River Entrance', -46.4167, 168.3333],
  ['Weiti River Entrance', -36.65, 174.7333],
  ['Welcombe Bay', -46.0833, 166.5833],
  ['Wellington', -41.2833, 174.7833],
  ['Westport', -41.75, 171.6],
  ['Whakatāne', -37.95, 177.0],
  ['Whanganui River Entrance', -39.95, 174.9833],
  ['Whangaroa', -35.05, 173.75],
  ['Whangārei', -35.7667, 174.35],
  ['Whitianga', -36.8333, 175.7],
  ['Wilson Bay', -41.0833, 173.9],
  ['Ōkukari Bay', -41.2, 174.3167],
  ['Ōmokoroa', -37.6333, 176.05],
  ['Ōpōtiki Wharf', -38.0, 177.2833]
].map(([name, latitude, longitude]) => ({ id: name, name, latitude, longitude }))

// Offset (ms) of the time zone from UTC at instant t.
function zoneOffset (t, timeZone) {
  const parts = {}
  new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).forEach(p => { parts[p.type] = p.value })
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second) - t
}

// Local wall time in the zone -> Date
function localTime (year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  let t = wall - zoneOffset(wall, timeZone)
  t = wall - zoneOffset(t, timeZone) // again, in case the first guess crossed a change of offset
  return new Date(t)
}

const dms = s => {
  const m = /(\d+)\s*°\s*(\d+(?:\.\d+)?)\s*['′´]?\s*([NSEW])/.exec(s)
  if (!m) return null
  const v = Number(m[1]) + Number(m[2]) / 60
  return m[3] === 'S' || m[3] === 'W' ? -v : v
}

function parseCsv (text, timeZone) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/)
  const head = (lines[0] || '').split(',').map(s => s.trim())
  const station = { name: head[1] || null, latitude: dms(head[2] || ''), longitude: dms(head[3] || '') }
  const points = []
  for (const line of lines) {
    const c = line.split(',').map(s => s.trim())
    if (!/^\d+$/.test(c[0] || '') || !/^\d+$/.test(c[2] || '') || !/^\d{4}$/.test(c[3] || '')) continue
    for (let i = 4; i + 1 < c.length; i += 2) {
      const tm = /^(\d{1,2}):(\d{2})$/.exec(c[i])
      const value = c[i + 1] === '' ? NaN : Number(c[i + 1])
      if (!tm || !isFinite(value)) continue
      points.push({ time: localTime(+c[3], +c[2], +c[0], +tm[1], +tm[2], timeZone || TIME_ZONE), value })
    }
  }
  points.sort((a, b) => a.time - b.time)
  // the file doesn't say which is high: a value above its neighbour is a high
  points.forEach((p, i) => {
    const other = points[i > 0 ? i - 1 : i + 1]
    p.flag = !other || p.value > other.value ? 'high' : 'low'
  })
  return { station, points }
}

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getText = deps.getText || http.getText

  function apiUrl (ctx) {
    return (ctx.options.linzApiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  }

  function folder () {
    const dir = typeof app.getDataDirPath === 'function' ? app.getDataDirPath() : app.config && app.config.configPath
    return dir ? path.join(dir, 'linz') : null
  }

  // The port's table for a year: from memory, the data folder, or LINZ.
  function table (ctx, port, year) {
    const s = ctx.state
    const key = `${port.id} ${year}`
    const tables = s.tables || (s.tables = {})
    if (tables[key]) return
    const dir = folder()
    const file = dir ? path.join(dir, `${key}.csv`) : null
    if (file) {
      try {
        tables[key] = parseCsv(fs.readFileSync(file, 'utf8'))
        return
      } catch (err) {
        // not downloaded yet
      }
    }
    ctx.job(`table ${year}`, `tide table ${year}`, () => {
      const url = `${apiUrl(ctx)}/${encodeURIComponent(key)}.csv`
      ctx.debug(`GET ${url}`)
      return getText(url, 'text/csv, text/plain, */*').then(text => {
        const parsed = parseCsv(text)
        if (parsed.points.length === 0) throw new Error(`no tide predictions in ${key}.csv`)
        tables[key] = parsed
        if (file) {
          fs.mkdir(dir, { recursive: true }, () => fs.writeFile(file, text, err => {
            if (err) ctx.debug(`could not save ${file}: ${err.message}`)
          }))
        }
      }, err => {
        if (/HTTP 404/.test(err.message)) throw noData(`no LINZ tide table for ${key}`)
        throw err
      })
    })
  }

  const spec = {
    optionKey: 'linz',
    title: 'LINZ (New Zealand)',
    name: 'LINZ',
    attribution: 'Land Information New Zealand (CC BY 4.0)',
    defaultRefreshMinutes: 360,
    properties: {
      linzMaxDistanceKm: {
        type: 'number',
        title: 'LINZ: use the nearest port within this distance (km)',
        default: 30
      },
      linzApiUrl: {
        type: 'string',
        title: 'LINZ: address of the tide table files',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const maxDistance = maxDistanceOption(ctx, 'linzMaxDistanceKm', 30)
      const found = nearest(PORTS, ctx.position)
      if (!found || found.distance > maxDistance) {
        ctx.state.station = undefined
        throw quiet(`no LINZ port within ${maxDistance / 1000} km`)
      }
      const port = ctx.state.station = found.item
      // the year in New Zealand, and the next one in the last week of the year
      const local = new Date(ctx.t + zoneOffset(ctx.t, TIME_ZONE))
      const year = local.getUTCFullYear()
      table(ctx, port, year)
      if (local.getUTCMonth() === 11 && local.getUTCDate() >= 25) table(ctx, port, year + 1)
    },
    view (ctx) {
      const port = ctx.state.station
      if (!port) return null
      const tables = Object.keys(ctx.state.tables || {}).filter(k => k.startsWith(`${port.id} `)).sort().map(k => ctx.state.tables[k])
      if (tables.length === 0) return null
      const head = tables[0].station
      return {
        station: {
          id: port.id,
          name: port.name,
          latitude: typeof head.latitude === 'number' ? head.latitude : port.latitude,
          longitude: typeof head.longitude === 'number' ? head.longitude : port.longitude
        },
        datum: 'CD',
        extremes: [].concat(...tables.map(t => t.points)).filter(p => p.time.getTime() > ctx.t - DAY)
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
module.exports.PORTS = PORTS
module.exports.parseCsv = parseCsv
module.exports.localTime = localTime
