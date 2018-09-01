module.exports = function (app, plugin) {
  var Promise = this.Promise || require('promise');
  var agent = require('superagent-promise')(require('superagent'), Promise)
  var heightLowTime, heightHighTime, heightLow, heightHigh
  var update = true
  var updates = []
  return {
    group: 'tides',
    optionKey: 'worldtides',
    title: 'Tide API from worldtides.info',
    derivedFrom: [ 'navigation.position'],
    properties: {
      worldtidesApiKey: {
        type: 'string',
        title: 'worldtides.info API key'
      }
    },
    debounceDelay: 60 * 1000,
    calculator: function (position) {
      app.debug('starting worldtides')

      return new Promise((resolve, reject) => {
        var now = Math.floor(new Date()/1000)
        if(app.getSelfPath('environment.tide.timeHigh')){
          heightHighTime = app.getSelfPath('environment.tide.timeHigh')
        }
        if(app.getSelfPath('environment.tide.timeLow')){
          heightLowTime = app.getSelfPath('environment.tide.timeLow')
        }
        const endPoint = 'https://www.worldtides.info/api?extremes&lat='+position.latitude+'&lon='+position.longitude+'&length=52200&start='+now+'&datum=LAT&key='+plugin.properties.tides.worldtidesApiKey

        if( typeof heightHighTime == 'undefined' || (now < heightHighTime || now < heightLowTime)){
          agent('GET', endPoint).end().then(function onResult(response)  {
            worldtidesToDeltas(JSON.parse(response.text))
          })
        } else {
          resolve(undefined)
          return
        }

        // DEV TESTING
        //var response = require('../responses/worldtides.json')
        //worldtidesToDeltas(response)


        function worldtidesToDeltas(response){
          app.debug('updating tide')
          if ( response.status != 200){
            reject(new Error('worldtides response: ' + response.error?response.error:'none'))
          } else {
            app.debug(JSON.stringify(response))
            let updates = []
            response.extremes.forEach((extreme, index) => {
              if (index > 1) return
              if (extreme.type == 'Low'){
                heightLowTime = new Date(extreme.dt*1000).toISOString()
                heightLow = extreme.height
                updates.push({
                  path: 'environment.tide.heightLow',
                  value: heightLow,
                })
                updates.push({
                  path: 'environment.tide.timeLow',
                  value: heightLowTime
                })
              }
              if (extreme.type == 'High'){
                heightHighTime = new Date(extreme.dt*1000).toISOString()
                heightHigh = extreme.height
                updates.push({
                  path: 'environment.tide.heightHigh',
                  value: heightHigh
                })
                updates.push({
                  path: 'environment.tide.timeHigh',
                  value: heightHighTime
                })
              }
            })
            resolve(updates)
          }
        }
      })
    }
  }
}
