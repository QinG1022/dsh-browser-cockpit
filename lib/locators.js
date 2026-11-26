/**
 * Locator syntax for browser targets.
 *
 * Besides a snapshot `ref` and a CSS `selector`, tools accept one string:
 * `role=button[name="Save"]`, `text=Save`, `label=Email`, `placeholder=Email`,
 * `testid=checkout`, `css=#main`, or `ref=e12`. The page-side matcher returns
 * every winning element so the caller can demand a unique match instead of
 * silently acting on the first one.
 * @module dsh-browser-cockpit/lib/locators
 */

/**
 * Page-side matcher. Kept as source text because it runs inside Chrome, not in
 * the Node process. `includeHidden` is used by assertions that need to see a
 * hidden element (for example elementHidden).
 */
const LOCATOR_SOURCE = String.raw`function (spec, includeHidden) {
  const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const visible = (element) => {
    if (element === null || element === undefined) return false;
    if (element.checkVisibility !== undefined) {
      try {
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch (error) { /* fall through to the manual checks */ }
    }
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const implicitRole = (element) => {
    const explicit = clean(element.getAttribute('role')).toLowerCase();
    if (explicit !== '') return explicit;
    const tag = element.tagName.toLowerCase();
    const type = clean(element.getAttribute('type')).toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'table') return 'table';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    return '';
  };
  const accessibleName = (element) => {
    const labelledby = clean(element.getAttribute('aria-labelledby'));
    const fromIds = labelledby === ''
      ? ''
      : labelledby.split(/\s+/).map((id) => document.getElementById(id)).filter((node) => node !== null)
        .map((node) => clean(node.innerText || node.textContent)).join(' ');
    const fromLabels = element.labels === undefined
      ? ''
      : Array.from(element.labels).map((label) => clean(label.innerText || label.textContent)).join(' ');
    return clean(
      element.getAttribute('aria-label')
      || fromIds
      || fromLabels
      || element.getAttribute('placeholder')
      || element.getAttribute('alt')
      || element.getAttribute('title')
      || element.innerText
      || element.value
      || '',
    );
  };
  const describe = (element) => {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? '#' + element.id : '';
    const text = clean(element.innerText || element.textContent || element.value || '').slice(0, 50);
    return tag + id + (text === '' ? '' : ' "' + text + '"');
  };
  const all = Array.from(document.querySelectorAll('*'));
  let matches = [];
  if (spec.kind === 'role') {
    matches = all.filter((element) => implicitRole(element) === spec.role);
    if (typeof spec.name === 'string' && spec.name !== '') {
      const wanted = spec.name.toLowerCase();
      matches = matches.filter((element) => {
        const name = accessibleName(element).toLowerCase();
        return spec.nameContains === true ? name.includes(wanted) : name === wanted;
      });
    }
  } else if (spec.kind === 'text') {
    const wanted = clean(spec.value).toLowerCase();
    const contains = (element) => clean(element.innerText || element.textContent).toLowerCase().includes(wanted);
    matches = all.filter(contains);
    matches = matches.filter((element) => !Array.from(element.querySelectorAll('*')).some((child) => contains(child)));
  } else if (spec.kind === 'label') {
    const wanted = clean(spec.value).toLowerCase();
    matches = all.filter((element) => {
      if (element.labels !== undefined && Array.from(element.labels).some((label) => clean(label.innerText || label.textContent).toLowerCase().includes(wanted))) return true;
      return clean(element.getAttribute('aria-label')).toLowerCase().includes(wanted);
    }).map((element) => element.tagName.toLowerCase() === 'label' && element.control !== undefined ? element.control : element);
  } else if (spec.kind === 'placeholder') {
    const wanted = clean(spec.value).toLowerCase();
    matches = all.filter((element) => clean(element.getAttribute('placeholder')).toLowerCase().includes(wanted));
  } else if (spec.kind === 'testid') {
    const wanted = clean(spec.value);
    matches = all.filter((element) => element.getAttribute('data-testid') === wanted
      || element.getAttribute('data-test') === wanted
      || element.getAttribute('data-test-id') === wanted);
  }
  matches = Array.from(new Set(matches));
  if (includeHidden !== true) matches = matches.filter(visible);
  return matches.slice(0, 50);
}`

/**
 * Build the page-side locator expression for one parsed target.
 * @param {{ kind: string, role?: string, name?: string, nameContains?: boolean, value?: string }} spec - parsed target.
 * @param {boolean} [includeHidden] - keep elements that are not visible.
 * @returns {string} a JavaScript expression returning an array of elements.
 */
export function locatorExpression(spec, includeHidden = false) {
  return `(${LOCATOR_SOURCE})(${JSON.stringify(spec)}, ${includeHidden === true ? 'true' : 'false'})`
}

/**
 * Normalize a snapshot ref to its `eN` form.
 * @param {string} value - e12 or 12.
 * @returns {string}
 */
function normalizeRef(value) {
  const raw = String(value).trim()
  return /^e\d+$/iu.test(raw) ? raw : `e${raw.replace(/[^0-9]/gu, '')}`
}

/**
 * Remove matching single or double quotes from a locator value.
 * @param {string} value - raw value.
 * @returns {string}
 */
function unquote(value) {
  const raw = String(value ?? '').trim()
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1).trim()
  }
  return raw
}

/**
 * Parse the unified `target` argument.
 * @param {{ target?: string, ref?: string, selector?: string }} target - tool target fields.
 * @returns {{ kind: 'ref', ref: string } | { kind: 'css', selector: string } | { kind: string, [key: string]: any }}
 */
export function parseTarget(target = {}) {
  const locator = typeof target.target === 'string' ? target.target.trim() : ''
  const ref = typeof target.ref === 'string' ? target.ref.trim() : ''
  const selector = typeof target.selector === 'string' ? target.selector.trim() : ''
  if (locator !== '') {
    if (ref !== '' || selector !== '') throw new Error('pass target or ref/selector, not both')
    return parseLocator(locator)
  }
  if (ref !== '') return { kind: 'ref', ref: normalizeRef(ref) }
  if (selector !== '') return { kind: 'css', selector }
  throw new Error('pass target, ref, or selector')
}

/**
 * Parse one locator string.
 * @param {string} raw - such as role=button[name="Save"] or text=Save.
 * @returns {object} parsed target.
 */
export function parseLocator(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error('the target is empty')
  if (/^e\d+$/iu.test(text)) return { kind: 'ref', ref: normalizeRef(text) }
  const lower = text.toLowerCase()
  if (lower.startsWith('ref=')) return { kind: 'ref', ref: normalizeRef(text.slice(4)) }
  if (lower.startsWith('css=')) {
    const selector = text.slice(4).trim()
    if (selector === '') throw new Error('css= needs a selector')
    return { kind: 'css', selector }
  }
  if (lower.startsWith('text*=')) {
    const value = unquote(text.slice(6))
    if (value === '') throw new Error('text*= needs text')
    return { kind: 'text', value }
  }
  if (lower.startsWith('text=')) {
    const value = unquote(text.slice(5))
    if (value === '') throw new Error('text= needs text')
    return { kind: 'text', value }
  }
  if (lower.startsWith('label=')) {
    const value = unquote(text.slice(6))
    if (value === '') throw new Error('label= needs text')
    return { kind: 'label', value }
  }
  if (lower.startsWith('placeholder=')) {
    const value = unquote(text.slice(12))
    if (value === '') throw new Error('placeholder= needs text')
    return { kind: 'placeholder', value }
  }
  if (lower.startsWith('testid=')) {
    const value = unquote(text.slice(7))
    if (value === '') throw new Error('testid= needs a value')
    return { kind: 'testid', value }
  }
  const role = /^role=([a-z][a-z0-9_-]*)(?:\[name(\*?)=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/iu.exec(text)
  if (role !== null) {
    const parsed = { kind: 'role', role: role[1].toLowerCase() }
    if (role[2] !== undefined) {
      const name = unquote(role[3] ?? role[4] ?? role[5] ?? '')
      if (name === '') throw new Error('role= name cannot be empty')
      parsed.name = name
      parsed.nameContains = role[2] === '*'
    }
    return parsed
  }
  if (!text.includes('=')) return { kind: 'css', selector: text }
  throw new Error('unsupported target; use role=button[name="Save"], text=Save, label=Email, '
    + 'placeholder=Email, testid=value, css=selector, or ref=e12')
}

/**
 * Human-readable form of one parsed target.
 * @param {object} spec - parsed target.
 * @returns {string}
 */
export function describeTarget(spec) {
  if (spec.kind === 'ref') return `ref ${spec.ref}`
  if (spec.kind === 'css') return `selector ${spec.selector}`
  if (spec.kind === 'role') return `role=${spec.role}${spec.name === undefined ? '' : `[name${spec.nameContains === true ? '*' : ''}="${spec.name}"]`}`
  return `${spec.kind}=${JSON.stringify(spec.value)}`
}
