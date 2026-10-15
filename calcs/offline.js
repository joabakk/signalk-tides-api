/*
 * Offline tide predictions: the astronomical tide computed on the boat from harmonic constants,
 * with no internet connection, using Neaps (https://neaps.js.org, MIT) and its station database
 * (TICON-4 tide gauges worldwide, NOAA stations in the US, and others).
 *
 * Only the astronomical tide: no wind, air pressure or measurements. Accuracy depends on the
 * station's data and on the distance to it. Neaps is an optional peer dependency (about 57 MB with its
 * database); without it the provider reports that it is missing and does nothing else.
 *
 * Licences differ per station and are shown in the plugin status: TICON-4 data is mostly
 * CC BY-NC 4.0 (no commercial use), NOAA data is public domain.
 */

const createProvider = require('../lib/tide-provider')
const { quiet, maxDistance, distance, HOUR, DAY } = createProvider

const MOVE_LIMIT = 1 // km before another station may be nearest

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const loadNeaps = deps.loadNeaps || (() => import('neaps'))

  function settings (ctx) {
    return {
      maxDistance: maxDistance(ctx, 'offlineMaxDistanceKm', 50) / 1000, // km, as Neaps gives distances
      datum: ['LAT', 'MLLW', 'MSL'].includes(ctx.options.offlineDatum) ? ctx.options.offlineDatum : undefined
    }
  }

  function compute (ctx, neaps, cfg) {
    const station = neaps.nearestStation({ latitude: ctx.position.latitude, longitude: ctx.position.longitude })
    if (!station || !(station.distance <= cfg.maxDistance)) {
      throw quiet(`no tide station within ${cfg.maxDistance} km in the offline database`)
    }
    // A datum the station doesn't have falls back to its own (usually its chart datum).
    const datum = cfg.datum && station.datums && station.datums[cfg.datum] !== undefined ? cfg.datum : undefined
    const options = datum ? { datum } : {}
    const ex = station.getExtremesPrediction(Object.assign({ start: new Date(ctx.t - HOUR), end: new Date(ctx.t + 7 * DAY) }, options))
    const tl = station.getTimelinePrediction(Object.assign({ start: new Date(ctx.t - HOUR), end: new Date(ctx.t + 2 * DAY), timeFidelity: 600 }, options))
    const licence = station.license || {}
    ctx.state.result = {
      key: `${station.id}|${cfg.datum || ''}`,
      position: ctx.position,
      computedAt: ctx.t,
      station: { id: station.id, name: station.name, latitude: station.latitude, longitude: station.longitude },
      datum: ex.datum || station.defaultDatum,
      extremes: ex.extremes.map(e => ({ time: new Date(e.time), value: e.level, flag: e.high ? 'high' : 'low' })),
      predicted: (tl.timeline || []).map(p => ({ time: new Date(p.time), value: p.level })),
      attribution: [
        `${(station.source && station.source.name) || 'tide database'} via Neaps`,
        licence.type || null,
        licence.commercial_use === false ? 'no commercial use' : null,
        `station ${station.distance.toFixed(1)} km away`
      ].filter(Boolean).join(', ')
    }
  }

  const spec = {
    optionKey: 'offline',
    fallback: true, // used by the tides resource only when no station-based provider answers
    title: 'Offline predictions (worldwide, no internet)',
    name: 'Offline',
    attribution: 'Neaps tide database',
    defaultRefreshMinutes: 360, // computed again after 6 hours (no option)
    properties: {
      offlineDatum: {
        type: 'string',
        title: 'Offline: reference level (zero) for heights',
        enum: ['default', 'LAT', 'MLLW', 'MSL'],
        enumNames: ["Station's own (usually its chart datum)", 'Lowest astronomical tide (LAT)', 'Mean lower low water (MLLW)', 'Mean sea level (MSL)'],
        default: 'default'
      },
      offlineMaxDistanceKm: {
        type: 'number',
        title: 'Offline: use the nearest tide station within this distance (km)',
        default: 50
      }
    },
    update (ctx) {
      const cfg = settings(ctx)
      if (!ctx.state.neaps) {
        ctx.job('load', 'tide database', () => loadNeaps().then(m => { ctx.state.neaps = m }, err => {
          throw new Error(`could not load Neaps (${err.message}). Install it in the Signal K server folder with: npm install neaps`)
        }))
      }
      ctx.job('compute', 'prediction', () => {
        const neaps = ctx.state.neaps
        if (!neaps) return
        const r = ctx.state.result
        const moved = r && distance(r.position, ctx.position) / 1000 > MOVE_LIMIT
        const fresh = r && !moved && r.key.endsWith(`|${cfg.datum || ''}`) && ctx.t - r.computedAt < ctx.refreshMs &&
          r.extremes.some(e => e.time.getTime() > ctx.t + DAY)
        if (fresh) return
        ctx.state.result = undefined
        compute(ctx, neaps, cfg)
      })
    },
    view (ctx) {
      return ctx.state.result || null
    }
  }

  return createProvider(app, plugin, spec, deps)
}
