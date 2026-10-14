/*
 * Offline tests for the HTTP endpoint of the NOAA provider, served by Signal K at
 *   /plugins/tides-api/closest
 * (the plugin registers it with registerWithRouter). The handler is captured from a fake
 * router and called with fake req/res objects.
 * NOAA itself is not contacted: superagent.get is replaced for the duration of each test.
 *
 * Run with: node test/noaa-endpoint.test.js
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const superagent = require('superagent')

const ROUTE = '/closest'
const STATIONS = {
  stations: [
    { id: '9447130', reference_id: '9447130', name: 'Seattle', lat: 47.6026, lng: -122.3393 },
    { id: '8443970', reference_id: '8443970', name: 'Boston', lat: 42.3539, lng: -71.0503 }
  ]
}
const NEAR_BOSTON = { latitude: 42.30, longitude: -70.95 }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Replaces superagent.get with a stub that answers from `respond(url)`:
// return { body } for success, or throw an Error (optionally with .response) for failure.
function stubNoaa (respond) {
  const original = superagent.get
  const urls = []
  superagent.get = url => {
    urls.push(new URL(url))
    return {
      set () { return this },
      then (ok, fail) {
        return Promise.resolve().then(() => respond(url)).then(ok, fail)
      }
    }
  }
  return { urls, restore: () => { superagent.get = original } }
}

function setup (state) {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-endpoint-'))
  fs.writeFileSync(path.join(configPath, 'noaastations.json'), JSON.stringify(STATIONS))
  const routes = {}
  const router = {
    levels: [],
    get () { throw new Error('should register with an access level') },
    access (level) {
      router.levels.push(level)
      return { get (route, handler) { routes[route] = handler } }
    }
  }
  const app = {
    config: { configPath },
    errors: [],
    pluginErrors: [],
    debug () {},
    error (m) { this.errors.push(m) },
    setPluginError (m) { this.pluginErrors.push(m) },
    use () { throw new Error('app.use should not be called') },
    getSelfPath (p) {
      if (p === 'navigation.position.value') return state.position
      if (p === 'navigation.datetime.value') return state.now
      return undefined
    }
  }
  const calc = require('../calcs/noaa.js')(app, {})
  calc.registerWithRouter(router)
  return { app, handler: routes[ROUTE], router }
}

// Calls the handler and resolves when it has answered.
function call (handler) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status (code) { this.statusCode = code; return this },
      send (body) { this.body = body; resolve(this) },
      json (body) { this.body = JSON.parse(JSON.stringify(body)); resolve(this) }
    }
    try {
      handler({}, res, () => reject(new Error('next() called')))
    } catch (err) {
      reject(err)
    }
    setTimeout(() => reject(new Error('handler did not answer')), 2000)
  })
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50)) // stations file is read asynchronously

test('registers the endpoint with the router as read-only, not app.use', async () => {
  const { handler, router } = setup({})
  assert.strictEqual(typeof handler, 'function')
  assert.deepStrictEqual(router.levels, ['readonly'])
})

test('older servers without router.access get a plain route', () => {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-endpoint-'))
  fs.writeFileSync(path.join(configPath, 'noaastations.json'), JSON.stringify(STATIONS))
  const app = { config: { configPath }, debug () {}, error () {}, getSelfPath () {} }
  const routes = []
  require('../calcs/noaa.js')(app, {}).registerWithRouter({ get (route) { routes.push(route) } })
  assert.deepStrictEqual(routes, ['/closest'])
})

test('the plugin passes its router to the providers', () => {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-endpoint-'))
  fs.writeFileSync(path.join(configPath, 'noaastations.json'), JSON.stringify(STATIONS))
  const app = {
    config: { configPath },
    selfId: 'x',
    debug () {},
    error () {},
    setPluginError () {},
    setPluginStatus () {},
    handleMessage () {},
    getSelfPath () {},
    use () { throw new Error('app.use should not be called') }
  }
  const plugin = require('../index.js')(app)
  const routes = []
  plugin.registerWithRouter({ get (route, handler) { routes.push([route, typeof handler]) } })
  assert.deepStrictEqual(routes, [['/closest', 'function']])
})

test('answers 401 without a position', async () => {
  const noaa = stubNoaa(() => { throw new Error('should not be called') })
  try {
    const { handler } = setup({})
    await settle()
    const res = await call(handler)
    assert.strictEqual(res.statusCode, 401)
    assert.strictEqual(res.body, 'no position')
    assert.strictEqual(noaa.urls.length, 0)
  } finally {
    noaa.restore()
  }
})

test('asks NOAA for the closest station and groups the predictions by day', async () => {
  const noaa = stubNoaa(() => ({
    body: {
      predictions: [
        { t: '2026-10-13 22:41', v: '3.112', type: 'H' },
        { t: '2026-10-14 04:55', v: '0.198', type: 'L' },
        { t: '2026-10-14 11:02', v: '3.004', type: 'H' }
      ]
    }
  }))
  try {
    const { handler } = setup({ position: NEAR_BOSTON, now: '2026-10-14T12:00:00Z' })
    await settle()
    const res = await call(handler)

    const q = noaa.urls[0].searchParams
    assert.strictEqual(noaa.urls[0].origin + noaa.urls[0].pathname, 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter')
    assert.strictEqual(q.get('station'), '8443970')
    assert.strictEqual(q.get('product'), 'predictions')
    assert.strictEqual(q.get('begin_date'), '20261013')
    assert.strictEqual(q.get('end_date'), '20261014')
    assert.strictEqual(q.get('datum'), 'MLLW')
    assert.strictEqual(q.get('time_zone'), 'gmt')
    assert.strictEqual(q.get('units'), 'metric')
    assert.strictEqual(q.get('interval'), 'hilo')
    assert.strictEqual(q.get('format'), 'json')

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.body.name, 'Boston')
    assert.strictEqual(res.body.id, '8443970')
    assert.deepStrictEqual(res.body.position, { latitude: 42.3539, longitude: -71.0503 })
    assert.deepStrictEqual(Object.keys(res.body.date).sort(), ['20261013', '20261014'])
    assert.deepStrictEqual(res.body.date['20261013'].height.values, [
      { value: 3.112, time: '2026-10-13T22:41:00.000Z' }
    ])
    assert.deepStrictEqual(res.body.date['20261014'].height.values.map(v => v.value), [0.198, 3.004])
  } finally {
    noaa.restore()
  }
})

test('passes on an error message from NOAA as 404', async () => {
  const noaa = stubNoaa(() => {
    const err = new Error('Bad Request')
    err.response = { body: { error: { message: 'No Predictions data was found.' } } }
    throw err
  })
  try {
    const { handler } = setup({ position: NEAR_BOSTON })
    await settle()
    const res = await call(handler)
    assert.strictEqual(res.statusCode, 404)
    assert.strictEqual(res.body, 'No Predictions data was found.')
  } finally {
    noaa.restore()
  }
})

test('answers 404 and reports the error when NOAA cannot be reached', async () => {
  const noaa = stubNoaa(() => { throw new Error('getaddrinfo ENOTFOUND api.tidesandcurrents.noaa.gov') })
  try {
    const { app, handler } = setup({ position: NEAR_BOSTON })
    await settle()
    const res = await call(handler)
    assert.strictEqual(res.statusCode, 404)
    assert.strictEqual(res.body, 'error')
    assert.ok(app.pluginErrors.some(m => m.includes('ENOTFOUND')))
  } finally {
    noaa.restore()
  }
})

;(async () => {
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`ok - ${t.name}`)
    } catch (err) {
      failed++
      console.log(`not ok - ${t.name}\n  ${err.stack.split('\n').join('\n  ')}`)
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`)
  process.exit(failed ? 1 : 0)
})()
