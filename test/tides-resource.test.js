/*
 * Offline tests for the tides resource (/signalk/v2/api/resources/tides): the plugin's
 * registration with the server and the order of the providers. Each provider's forecast is tested
 * in its own test file.
 *
 * Run with: node test/tides-resource.test.js
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function configDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tides-resource-'))
}

// --- registration by the plugin ---------------------------------------------------

function pluginSetup (props) {
  const providers = []
  const app = {
    config: { configPath: configDir() },
    selfId: 'x',
    debug () {},
    error () {},
    setPluginError () {},
    setPluginStatus () {},
    handleMessage () {},
    getSelfPath () {},
    registerResourceProvider (provider) { providers.push(provider) },
    use () { throw new Error('app.use should not be called') }
  }
  const plugin = require('../index.js')(app)
  plugin.start(props)
  return { plugin, providers }
}

test('plugin: registers a read-only tides resource provider', async () => {
  const { plugin, providers } = pluginSetup({ tides: {} })
  try {
    assert.strictEqual(providers.length, 1)
    assert.strictEqual(providers[0].type, 'tides')
    const m = providers[0].methods
    assert.deepStrictEqual(Object.keys(m).sort(), ['deleteResource', 'getResource', 'listResources', 'setResource'])
    await assert.rejects(m.setResource('x', {}), /Read-only/)
    await assert.rejects(m.deleteResource('x'), /Read-only/)
    await assert.rejects(m.getResource('x'), /Not implemented/)
  } finally {
    plugin.stop()
  }
})

test('plugin: the resource comes from an enabled provider', async () => {
  const none = pluginSetup({ tides: {} })
  try {
    await assert.rejects(none.providers[0].methods.listResources({}), /No tide provider with forecasts is enabled/)
  } finally {
    none.plugin.stop()
  }
  const worldtidesOnly = pluginSetup({ tides: { worldtides: true } })
  try {
    await assert.rejects(worldtidesOnly.providers[0].methods.listResources({}), /No tide provider with forecasts is enabled/)
  } finally {
    worldtidesOnly.plugin.stop()
  }
  // Kartverket enabled: its forecast is asked (and rejects here, as there is no position)
  const kartverket = pluginSetup({ tides: { kartverket: true } })
  try {
    await assert.rejects(kartverket.providers[0].methods.listResources({}), /No position/)
  } finally {
    kartverket.plugin.stop()
  }
})

test('plugin: station-based providers come before the model and offline fallbacks', () => {
  const { forecastOrder } = require('../index.js')
  const calc = (optionKey, fallback) => ({ optionKey, fallback, tideForecast () {} })
  const calcs = [calc('chs'), calc('kartverket'), calc('offline', true), calc('openmeteo', true), calc('rws'), { optionKey: 'worldtides' }]
  const keys = tides => forecastOrder(calcs, tides).map(c => c.optionKey)
  assert.deepStrictEqual(keys({ offline: true, openmeteo: true, kartverket: true, rws: true, worldtides: true }),
    ['kartverket', 'rws', 'offline', 'openmeteo'])
  assert.deepStrictEqual(keys({ openmeteo: true }), ['openmeteo'])
  assert.deepStrictEqual(keys({}), [])
  // the real providers say which are fallbacks
  const loaded = fs.readdirSync(path.join(__dirname, '..', 'calcs'))
    .map(f => require(path.join('..', 'calcs', f))({ config: { configPath: configDir() }, debug () {}, error () {} }, { properties: {} }))
  const fallbacks = loaded.filter(c => c && c.fallback).map(c => c.optionKey).sort()
  assert.deepStrictEqual(fallbacks, ['offline', 'openmeteo'])
})

test('plugin: the resource can be turned off', () => {
  const { plugin, providers } = pluginSetup({ tidesResource: false, tides: { kartverket: true } })
  try {
    assert.strictEqual(providers.length, 0)
  } finally {
    plugin.stop()
  }
  const schema = plugin.schema()
  assert.strictEqual(schema.properties.tidesResource.type, 'boolean')
  assert.strictEqual(schema.properties.tidesResource.default, true)
})

test('plugin: servers without registerResourceProvider still start', () => {
  const app = {
    config: { configPath: configDir() },
    selfId: 'x',
    debug () {},
    error () {},
    setPluginError () {},
    getSelfPath () {}
  }
  const plugin = require('../index.js')(app)
  assert.doesNotThrow(() => plugin.start({ tides: {} }))
  plugin.stop()
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
