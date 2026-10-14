const superagent = require("superagent")
const path = require('path')
const fs = require('fs')
const geolib = require('geolib')
const { URL } = require('url');
const moment = require('moment');

const apiUrl = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi'
const stationsUrl = apiUrl + '/stations.json?type=tidepredictions'
const dataGetterUrl = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'

const datum = 'MLLW'

// Stand-in for the deprecated request module, for the GET + json calls below:
// callback(error, response, body). Error statuses still deliver their body, and the
// callback runs outside the promise chain like it did with request.
function request(options, callback) {
  superagent
    .get(options.url)
    .set('Accept', 'application/json')
    .then(
      res => setImmediate(() => callback(null, res, res.body)),
      err => setImmediate(() => err.response
        ? callback(null, err.response, err.response.body)
        : callback(err))
    )
}

module.exports = function (app, plugin) {
  const stationsFile = path.join(app.config.configPath, 'noaastations.json')
  var stations
  var sorted
  var downloadingStations = false
  var lastLowTime
  var lastHighTime


  function reportError(error) {
    // setPluginError replaces setProviderError in newer servers
    if ( app.setPluginError ) {
      app.setPluginError(error.message)
    } else if ( app.setProviderError ) {
      app.setProviderError(error.message)
    }
    app.error("error: " + error.message)
  }

  function downloadStations() {
    downloadingStations = true
    if ( !fs.existsSync(stationsFile) ) {
      app.debug('downloading stations...')
      request({
        url: stationsUrl,
        method: "GET",
        json: true,
      }, (error, response, body) => {
        if ( error ) {
          reportError(error)
        } else {
          let stationArray = body.stations
          stations = new Map(stationArray.map((station) => [station.id, station]));
          fs.writeFile(stationsFile, JSON.stringify(body, null, 2), err => {
            if ( err ) {
              reportError(err)
            } else {
              downloadingStations = false
            }
          })
        }
      })
    } else {
      app.debug(`reading stations from ${stationsFile}`)
      fs.readFile(stationsFile, (err, data) => {
        if ( err ) {
          reportError(err)
        } else {
          try {
            let json = JSON.parse(data)
            let stationArray = json.stations
            stations = new Map(stationArray.map((station) => [station.id, station]));

            downloadingStations = false
          } catch ( err ) {
            reportError(err)
          }
        }
      })
    }
  }

  downloadStations()

  // Next 7 days of high and low tides at the NOAA station closest to the boat, in the shape
  // of the 'tides' resource of signalk-tides. Cached for an hour per station.
  let forecastCache

  function tideForecast() {
    return new Promise((resolve, reject) => {
      const position = app.getSelfPath('navigation.position.value')
      if ( !position ) {
        reject(new Error('No position'))
        return
      }
      if ( !stations || stations.size === 0 ) {
        reject(new Error('NOAA stations not loaded'))
        return
      }
      const station = sortStations(app, stations, position)[0]
      const nowS = app.getSelfPath('navigation.datetime.value')
      const now = nowS ? new Date(nowS) : new Date()

      if ( forecastCache && forecastCache.stationId === station.id &&
           now.getTime() - forecastCache.fetchedAt < 60 * 60 * 1000 ) {
        resolve(forecastCache.value)
        return
      }

      const endpoint = new URL(dataGetterUrl);
      const params = endpoint.searchParams;
      params.set('product', 'predictions');
      params.set('application', 'signalk.org/node-server');
      params.set('begin_date', moment.utc(now).format('YYYYMMDD HH:mm'));
      params.set('range', 7 * 24);
      params.set('datum', datum);
      params.set('station', station.id);
      params.set('time_zone', 'gmt');
      params.set('units', 'metric');
      params.set('interval', 'hilo');
      params.set('format', 'json');
      app.debug(`${endpoint}`)

      request({
        url: `${endpoint}`,
        method: "GET",
        json: true,
      }, (error, response, body) => {
        if ( error ) {
          reportError(error)
          reject(error)
          return
        }
        if ( body.error ) {
          reject(new Error(`error response: ${body.error.message}`))
          return
        }
        const value = {
          datum,
          units: 'meters',
          station: {
            id: `noaa/${station.id}`,
            name: station.name,
            latitude: station.lat,
            longitude: station.lng
          },
          extremes: (body.predictions || [])
            .map(p => {
              const high = p.type === 'H'
              return {
                time: new Date(moment(`${p.t}Z`)).toISOString(),
                level: Number(p.v),
                high,
                low: !high,
                label: high ? 'High' : 'Low'
              }
            })
            .filter(e => new Date(e.time) > now)
        }
        forecastCache = { stationId: station.id, fetchedAt: now.getTime(), value }
        resolve(value)
      })
    })
  }

  return {
    group: 'tides',
    optionKey: 'noaa',
    title: 'NOAA (US only)',
    tideForecast,
    derivedFrom: [ 'navigation.position'],
    debounceDelay: 10 * 1000,
    calculator: function (position) {
      if ( !stations || downloadingStations ) {
        app.debug('skipping ' + downloadingStations)
        return
      }

      return new Promise((resolve, reject) => {
        if ( ! sorted ) {
          sorted = sortStations(app, stations, position)
        }

        let station = findClosestStation(app, sorted, position)

        let nowS = app.getSelfPath('navigation.datetime.value')
        let now = nowS ? new Date(nowS) : new Date()

        if ( lastHighTime && lastLowTime && now.getTime() < lastHighTime && now.getTime() < lastLowTime ) {
          app.debug('waiting for tide change')
          resolve(undefined)
          return
        }

        const endpoint = new URL(dataGetterUrl);
        const params = endpoint.searchParams;
        params.set('station', station.id);
        params.set('begin_date', moment.utc(now).format('YYYYMMDD HH:mm'));
        params.set('range', 24 * 1);
        params.set('product', 'predictions');
        params.set('application', 'signalk.org/node-server');
        params.set('datum', datum);
        params.set('time_zone', 'gmt');
        params.set('units', 'metric');
        params.set('interval', 'hilo');
        params.set('format', 'json');
        app.debug(`${endpoint}`)

        request({
          url: `${endpoint}`,
          method: "GET",
          json: true,
        }, (error, response, body) => {
          if ( error ) {
            reportError(error)
            reject(error)
          } else {
            app.debug(JSON.stringify(body, null, 2))

            if ( body.error ) {
              reject(new Error(`error response: ${body.error.message}`))
              return
            }

            let nextHigh
            let nextLow
            body.predictions.forEach(p => {
              let date = new Date(moment(`${p.t}Z`))

              if ( date.getTime() > now.getTime() ) {
                if ( !nextHigh && p.type === 'H' ) {
                  nextHigh = p
                  p.date = date
                } else if ( !nextLow && p.type === 'L' ) {
                  nextLow = p
                  p.date = date
                }
              }
            })

            let updates = []
            if ( nextLow ) {
              lastLowTime = nextLow.date.getTime()
              updates.push({
                path: 'environment.tide.heightLow',
                value: Number(nextLow.v),
              })
              updates.push({
                path: 'environment.tide.timeLow',
                value: nextLow.date.toISOString()
              })
            }
            if ( nextHigh ) {
              lastHighTime = nextHigh.date.getTime()
              updates.push({
                path: 'environment.tide.heightHigh',
                value: Number(nextHigh.v),
              })
              updates.push({
                path: 'environment.tide.timeHigh',
                value: nextHigh.date.toISOString()
              })
            }
            resolve(updates)
          }
        })
      })
    }
  }
}


function findClosestStation(app, sorted, position) {
  let res = findNearStations(app, sorted, position, 1)
  return res[0]
}

function sortStations(app, stations, position) {
  const stationsWithDistances = [...stations.values()].map((station) => ({
    ...station,
    distance: geolib.getDistance(position, {latitude: station.lat, longitude: station.lng})
  }));

  stationsWithDistances.sort((a, b) => a.distance - b.distance);
  return stationsWithDistances
}

function findNearStations(app, sorted, position, limit = 10) {
  return sorted.slice(0, limit)
}
