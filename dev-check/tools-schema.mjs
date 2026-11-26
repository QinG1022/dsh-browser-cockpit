import { registerBrowserTools } from '../lib/tools.js'

// Regression guard for the tool registration path: model-facing tools must
// receive a single object-rooted JSON Schema, never the authoring map whose
// parameter names would become root keywords (title, description, ...).
const tools = new Map()
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  get: () => undefined,
}
const session = { redact: (value) => value }
registerBrowserTools(ctx, session, (input) => ({ target: String(input), cleanAfterLoad: false }), {
  begin() {},
  finish() {},
})

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`ok ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail === '' ? '' : `: ${detail}`}`)
  }
}
const allowedRootKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', '$schema'])

check('tool count is 29', tools.size === 29, String(tools.size))
for (const [name, tool] of tools) {
  const schema = tool.parameters
  check(`${name}: object schema`, schema?.type === 'object' && schema.properties !== null && typeof schema.properties === 'object', JSON.stringify(schema))
  const rootKeys = Object.keys(schema ?? {}).filter((key) => !allowedRootKeys.has(key))
  check(`${name}: no parameter at root`, rootKeys.length === 0, rootKeys.join(','))
  check(`${name}: no inline required flag`, Object.values(schema?.properties ?? {}).every((property) => property.required === undefined))
  check(`${name}: required array only names properties`, (schema?.required ?? []).every((key) => Object.hasOwn(schema.properties, key)), JSON.stringify(schema?.required))
}

const assertSchema = tools.get('browser_assert')?.parameters
check('browser_assert keeps title property', assertSchema?.properties?.title?.type === 'string')
check('browser_assert requires condition', JSON.stringify(assertSchema?.required) === '["condition"]', JSON.stringify(assertSchema?.required))
check('browser_open requires url', JSON.stringify(tools.get('browser_open')?.parameters.required) === '["url"]')
check('browser_type exposes text and secret', tools.get('browser_type')?.parameters.properties.text?.type === 'string'
  && tools.get('browser_type')?.parameters.properties.secret?.type === 'string')
check('browser_type validates text/secret at runtime', tools.get('browser_type')?.parameters.required === undefined)
check('browser_click has no required property', tools.get('browser_click')?.parameters.required === undefined)

if (failures > 0) {
  console.log(`${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}
