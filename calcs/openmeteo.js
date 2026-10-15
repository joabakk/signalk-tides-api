/*
 * Open-Meteo marine API (worldwide, model data): https://open-meteo.com/en/docs/marine-weather-api
 *
 * sea_level_height_msl is the modelled sea level including tides and the inverted barometer
 * effect (air pressure), relative to global mean sea level, on a grid of about 8 km (Copernicus
 * Marine Service). invert_barometer_height is the air pressure part of it. The provider publishes:
 *   heightForecast    sea_level_height_msl
 *   weatherEffect     invert_barometer_height (air pressure only, not wind)
 *   heightPredicted   the difference: roughly the tide without the air pressure effect
 *   high and low      from that series
 * Open-Meteo: "not suitable for coastal navigation", accuracy near the coast is limited.
 *
 * Free for non-commercial use (under 10 000 calls a day), no key. Data CC BY 4.0, credit
 * Open-Meteo with a link. One request per refresh interval (default 60 min).
 */

const createProvider = require('../lib/tide-provider')
const { http, buildUrl, noData } = createProvider

const DEFAULT_API_URL = 'https://marine-api.open-meteo.com/v1/marine'
const REFETCH_DISTANCE = 4000 // half a grid cell, metres

module.exports = function (app, plugin, deps) {
  deps = deps || {}
  const getJson = deps.getJson || http.getJson

  function read (body) {
    if (!body || typeof body !== 'object') throw new Error('empty answer')
    if (body.error) throw new Error(`Open-Meteo: ${body.reason || 'error'}`)
    const h = body.hourly || {}
    const times = h.time || []
    const level = h.sea_level_height_msl || []
    const pressure = h.invert_barometer_height || []
    const forecast = []
    const predicted = []
    const weather = []
    times.forEach((t, i) => {
      const time = new Date(typeof t === 'number' ? t * 1000 : `${t}Z`)
      if (isNaN(time.getTime())) return
      const v = level[i]
      const ib = pressure[i]
      if (typeof v === 'number') forecast.push({ time, value: v })
      if (typeof ib === 'number') weather.push({ time, value: ib })
      if (typeof v === 'number' && typeof ib === 'number') predicted.push({ time, value: v - ib })
    })
    if (forecast.length === 0) {
      throw noData('no sea level for this position (on land, or outside the model)')
    }
    return { forecast, predicted, weather, latitude: body.latitude, longitude: body.longitude }
  }

  const spec = {
    optionKey: 'openmeteo',
    title: 'Open-Meteo (worldwide model, not for coastal navigation)',
    name: 'Open-Meteo',
    attribution: 'Open-Meteo.com (CC BY 4.0), sea level from Copernicus Marine Service; model data, not for coastal navigation',
    refreshKey: 'openmeteoRefreshMinutes',
    defaultRefreshMinutes: 60,
    minRefreshMinutes: 30,
    properties: {
      openmeteoRefreshMinutes: {
        type: 'number',
        title: 'Open-Meteo: minutes between updates (minimum 30)',
        default: 60
      },
      openmeteoApiUrl: {
        type: 'string',
        title: 'Open-Meteo: API address (change only for a commercial plan or your own server)',
        default: DEFAULT_API_URL
      }
    },
    update (ctx) {
      const cached = ctx.state.data
      const moved = cached && require('geolib').getDistance(cached.position, ctx.position) > REFETCH_DISTANCE
      if (cached && !moved && ctx.t - cached.fetchedAt < ctx.refreshMs) return
      ctx.job('data', 'sea level', () => {
        const url = buildUrl(ctx.options.openmeteoApiUrl || DEFAULT_API_URL, {
          latitude: ctx.position.latitude.toFixed(3),
          longitude: ctx.position.longitude.toFixed(3),
          hourly: 'sea_level_height_msl,invert_barometer_height',
          past_days: 1,
          forecast_days: 7,
          timezone: 'GMT',
          timeformat: 'unixtime'
        })
        ctx.debug(`GET ${url}`)
        return getJson(url).then(body => {
          ctx.state.data = Object.assign(read(body), { position: ctx.position, fetchedAt: ctx.t })
        }, err => {
          ctx.state.data = undefined
          throw err
        })
      })
    },
    view (ctx) {
      const d = ctx.state.data
      if (!d) return null
      const latitude = typeof d.latitude === 'number' ? d.latitude : d.position.latitude
      const longitude = typeof d.longitude === 'number' ? d.longitude : d.position.longitude
      return {
        station: { id: `${latitude.toFixed(3)},${longitude.toFixed(3)}`, name: 'model grid cell', latitude, longitude },
        datum: 'MSL',
        predicted: d.predicted,
        forecast: d.forecast,
        weatherEffect: d.weather
      }
    }
  }

  return createProvider(app, plugin, spec, deps)
}

module.exports.DEFAULT_API_URL = DEFAULT_API_URL
