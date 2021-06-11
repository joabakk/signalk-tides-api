const request = require("request")
const path = require('path')
const fs = require('fs')
const geolib = require('geolib')
const { URL } = require('url');
const moment = require('moment');

const apiUrl = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi'
const stationsUrl = apiUrl + '/stations.json?type=tidepredictions'
const dataGetterUrl = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'

const datum = 'MLLW'

module.exports = function (app, plugin) {
  const stationsFile = path.join(app.config.configPath, 'noaastations.json')
  var stations
  var sorted
  var downloadingStations = false
  var lastLowTime
  var lastHighTime


  function reportError(error) {
    app.setProviderError(error.message)
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

  app.use('/signalk/v1/api/resources/tides/closest', (req, res, next) => {
    let position = app.getSelfPath('navigation.position.value')

    if ( !position ) {
      res.status(401).send('no position')
      return
    }

    if ( ! sorted ) {
      app.debug(position, stations)
      sorted = sortStations(app, stations, position)
    }

    let nowS = app.getSelfPath('navigation.datetime.value')
    let now = nowS ? new Date(nowS) : new Date()

    let station = findClosestStation(app, sorted, position)
    const endpoint = new URL(dataGetterUrl);
    const params = endpoint.searchParams;
    params.set('product', 'predictions');
    params.set('application', 'signalk.org/node-server');
    params.set('begin_date', moment(now).subtract(1, 'day').format('YYYYMMDD'));
    params.set('end_date', moment(now).format('YYYYMMDD'));
    params.set('datum', datum);
    params.set('station', station.reference_id);
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
        res.status(404).send('error')
      } else {
        //app.debug(JSON.stringify(body, null, 2))

        if ( body.error ) {
          res.status(404).send(body.error.message)
        } else {
          let tides = {
            name: station.name,
            id: station.reference_id,
            position: {
              latitude: station.lat,
              longitude: station.lng
            },
            date: {}
          }
          body.predictions.forEach(p => {
            let dateString = moment(`${p.t}Z`)
            let dateKey = dateString.format('YYYYMMDD')
            let date = tides.date[dateKey]
            if ( !date ) {
              date = { height: { values: [] } }
              tides.date[dateKey] = date
            }

            let values = date.height.values
            values.push({
              value: Number(p.v),
              time: dateString
            })
          })
          res.json(tides)
        }
      }
    })
  })

  return {
    group: 'tides',
    optionKey: 'noaa',
    title: 'NOAA (US only)',
    derivedFrom: [ 'navigation.position'],
    debounceDelay: 10 * 1000,
    calculator: function (position) {
      if ( !stations || downloadingStations ) {
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
          resolve(undefined)
          return
        }

        const endpoint = new URL(dataGetterUrl);
        const params = endpoint.searchParams;
        params.set('station', station.id);
        params.set('begin_date', moment(now).format('YYYYMMDD MM:mm'));
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
            //app.debug(JSON.stringify(body, null, 2))

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
