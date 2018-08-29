module.exports = function (app, plugin) {
  var heightLowTime, heightHighTime, heightLow, heightHigh
  var update = false
  var Promise = this.Promise || require('promise');
  var agent = require('superagent-promise')(require('superagent'), Promise)
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

      var now = Math.floor(new Date()/1000)
      if(app.getSelfPath('environment.tide.timeHigh')){
        heightHighTime = app.getSelfPath('environment.tide.timeHigh')
      }
      if(app.getSelfPath('environment.tide.timeLow')){
        heightLowTime = app.getSelfPath('environment.tide.timeLow')
      }
      const endPoint = 'https://www.worldtides.info/api?extremes&lat='+position.latitude+'&lon='+position.longitude+'&length=52200&start='+now+'&key='+plugin.properties.tides.worldtidesApiKey
      //app.debug(endPoint)
      if( typeof heightHighTime == 'undefined' || (now < heightHighTime || now < heightLowTime)){
        agent('GET', endPoint).end().then(function onResult(response)  {
          worldtidesToDeltas(JSON.parse(response.text))
        })
      }
      function worldtidesToDeltas(response){
        app.debug('updating tide')
        if ( response.status != 200){
          app.debug('worldtides response: ' + response.error?response.error:'none')
        } else {
          app.debug(JSON.stringify(response))
          response.extremes.forEach(extreme => {
            if (extreme.type == 'Low'){
              //app.debug(extreme.dt)
              heightLowTime = new Date(extreme.dt*1000).toISOString()
              //app.debug('lowtime: ' + heightLowTime)
              heightLow = extreme.height
            }
            if (extreme.type == 'High'){
              heightHighTime = new Date(extreme.dt*1000).toISOString()
              heightHigh = extreme.height
            }
          })
          update = true
        }
      }
      //if(update){
        update = false
        return [
        {
          path: 'environment.tide.heightHigh',
          value: heightHigh
        },
        {
          path: 'environment.tide.heightLow',
          value: heightLow
        },
        {
          path: 'environment.tide.timeLow',
          value: heightLowTime
        },
        {
          path: 'environment.tide.timeHigh',
          value: heightHighTime
        }
      ]
    //}
    }
  }
}
/*
{
  "status": 200,
  "callCount": 1,
  "copyright": "Tidal data retrieved from www.worldtide.info. Copyright (c) 2014-2017 Brainware LLC. Licensed for use of individual spatial coordinates on behalf of/by an end-user. Copyright (c) 2010-2016 Oregon State University. Licensed for individual spatial coordinates via ModEM-Geophysics Inc. NO GUARANTEES ARE MADE ABOUT THE CORRECTNESS OF THIS DATA. You may not use it if anyone or anything could come to harm as a result of using it (e.g. for navigational purposes).",
  "requestLat": 60.084516666667,
  "requestLon": 23.5391,
  "responseLat": 60,
  "responseLon": 24,
  "atlas": "TPXO_8_v1",
  "extremes": [
    {
      "dt": 1535472977,
      "date": "2018-08-28T16:16+0000",
      "height": -0.001,
      "type": "Low"
    },
    {
      "dt": 1535483704,
      "date": "2018-08-28T19:15+0000",
      "height": 0,
      "type": "High"
    }
  ]
}
*/
