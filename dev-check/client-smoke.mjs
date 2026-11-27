/**
 * Render the left panel once with a tiny React stand-in.
 *
 * The real panel is registered into the `main` slot and cannot be imported
 * directly, so this loads the client bundle through a fake module loader and
 * invokes the captured component. It catches broken references that
 * `node --check` cannot see (the missing `running`/`phase` locals that made the
 * left sidebar panel fail to open in v1.3.0/v1.4.0).
 */
import fs from 'node:fs'
import vm from 'node:vm'

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
  innerWidth: 1200,
}
globalThis.localStorage = { getItem: () => '', setItem() {}, removeItem() {} }
globalThis.document = { querySelector: () => null }

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial }
  },
}

vm.runInThisContext(fs.readFileSync('client.js', 'utf8'), { filename: 'client.js' })
if (loaded === null) throw new Error('module loader was not called')

const components = new Map()
const ctx = {
  effect(fn) {
    fn()
  },
  locale: {
    register() {},
    bind() {
      return (key) => key
    },
  },
  slots: {
    inject(name, callback) {
      callback({
        register(definition, component) {
          components.set(definition.name, component)
        },
      })
    },
    register(definition, component) {
      components.set(definition.name, component)
    },
  },
  inject() {},
}

const module = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
module.apply(ctx)

const Panel = components.get('main')
if (typeof Panel !== 'function') throw new Error('BrowserPanel was not registered')
const tree = Panel({ t: (key) => key, onOpenRight() {} })
if (tree === null || typeof tree !== 'object') throw new Error('BrowserPanel returned no tree')
console.log('ok client panel renders')
