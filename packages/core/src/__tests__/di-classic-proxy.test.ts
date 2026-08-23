import fs from 'node:fs'
import path from 'node:path'
import { asFunction, asValue, createContainer, InjectionMode } from 'awilix'

// The request container is built in Awilix CLASSIC injection mode
// (packages/shared/src/lib/di/container.ts). CLASSIC resolves dependencies by
// parsing the factory's parameter NAMES and passing one resolved dependency per
// parameter, positionally. Three registration shapes therefore misbehave, and
// none of them is caught by a unit test that injects fakes directly:
//
//   1. a destructured first parameter — asFunction(({ em }) => ...) — receives
//      the positionally-resolved `em` as the object being destructured, so every
//      destructured binding comes out undefined (silent) or, for a renamed
//      binding, resolution throws;
//   2. a single cradle-shaped parameter — asFunction((cradle) => ...) — makes
//      the container look for a registration literally named `cradle` and throw;
//   3. a TypeScript-optional parameter — asFunction((em, cache?) => ...) — the
//      `?` marker is erased at transpile, so awilix sees a REQUIRED parameter
//      and throws when that dependency is absent. Only a runtime default value
//      (`cache = null`) survives transpilation and marks it optional.
//
// Shapes 1 and 2 are fixed by chaining `.proxy()` on the registration; shape 3
// by replacing `?` with a default value. See issue #33.

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')

// `external/official-modules` is an optional submodule with its own git and its
// own CI, so it is deliberately out of scope here.
const scanRoots = ['packages', 'apps']

const skippedDirectories = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.mercato',
  '.turbo',
  '__tests__',
])

// DI keys that no scanned file registers with a literal `key: asX(...)` — add an
// entry here (with a comment naming the registrar) when a dependency is wired
// dynamically instead of through the usual object-literal registration.
const externallyRegisteredDiKeys: string[] = []

function listSourceFiles(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name)) continue
        walk(path.join(directory, entry.name))
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        files.push(path.join(directory, entry.name))
      }
    }
  }
  for (const root of scanRoots) {
    const absolute = path.join(repoRoot, root)
    if (fs.existsSync(absolute)) walk(absolute)
  }
  return files
}

function findMatchingParen(source: string, openParenIndex: number): number {
  let depth = 0
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function splitTopLevel(parameterList: string): string[] {
  const entries: string[] = []
  let depth = 0
  let angleDepth = 0
  let current = ''
  for (const char of parameterList) {
    if ('([{'.includes(char)) depth += 1
    if (')]}'.includes(char)) depth -= 1
    if (char === '<') angleDepth += 1
    if (char === '>') angleDepth -= 1
    if (char === ',' && depth === 0 && angleDepth === 0) {
      entries.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length) entries.push(current)
  return entries
}

function hasTopLevelDefault(entry: string): boolean {
  let depth = 0
  let angleDepth = 0
  for (let index = 0; index < entry.length; index += 1) {
    const char = entry[index]
    if ('([{'.includes(char)) depth += 1
    if (')]}'.includes(char)) depth -= 1
    if (char === '<') angleDepth += 1
    if (char === '>') {
      if (entry[index - 1] === '=') continue
      angleDepth -= 1
    }
    if (char !== '=' || depth !== 0 || angleDepth !== 0) continue
    if (entry[index + 1] === '=' || entry[index + 1] === '>') continue
    if (entry[index - 1] === '=' || entry[index - 1] === '!' || entry[index - 1] === '<' || entry[index - 1] === '>') continue
    return true
  }
  return false
}

type FactoryParameter = {
  name: string
  destructured: boolean
  typescriptOptional: boolean
  hasDefault: boolean
}

type Registration = {
  file: string
  line: number
  key: string
  proxied: boolean
  /** `null` when the factory is an imported reference whose parameters are not visible here. */
  parameters: FactoryParameter[] | null
}

function parseParameterList(parameterList: string): FactoryParameter[] {
  return splitTopLevel(parameterList).map((entry) => {
    const trimmed = entry.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return { name: trimmed, destructured: true, typescriptOptional: false, hasDefault: false }
    }
    const name = trimmed.match(/^\.{0,3}([A-Za-z_$][\w$]*)/)?.[1] ?? trimmed
    return {
      name,
      destructured: false,
      typescriptOptional: new RegExp(`^\\.{0,3}${name}\\s*\\?`).test(trimmed),
      hasDefault: hasTopLevelDefault(trimmed),
    }
  })
}

function parseFactoryParameters(resolverArgument: string): FactoryParameter[] | null {
  const body = resolverArgument.replace(/^\s*(async\s+)?/, '')
  if (body.startsWith('(')) {
    const closeIndex = findMatchingParen(body, 0)
    if (closeIndex === -1) return null
    return parseParameterList(body.slice(1, closeIndex))
  }
  if (body.startsWith('function')) {
    const openIndex = body.indexOf('(')
    if (openIndex === -1) return null
    const closeIndex = findMatchingParen(body, openIndex)
    if (closeIndex === -1) return null
    return parseParameterList(body.slice(openIndex + 1, closeIndex))
  }
  const singleParameter = body.match(/^([A-Za-z_$][\w$]*)\s*=>/)
  if (singleParameter) return parseParameterList(singleParameter[1])
  // `asFunction(createSomeService)` — the factory lives in another module, so
  // its parameters cannot be inspected from here.
  return null
}

function collectRegistrations(file: string): Registration[] {
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes('asFunction')) return []
  const registrations: Registration[] = []
  const factoryStart = /asFunction\s*\(/g
  let match: RegExpExecArray | null
  while ((match = factoryStart.exec(source)) !== null) {
    const openParenIndex = match.index + match[0].length - 1
    const closeParenIndex = findMatchingParen(source, openParenIndex)
    if (closeParenIndex === -1) continue
    const precedingText = source.slice(0, match.index)
    const lastLine = precedingText.split('\n').pop() ?? ''
    registrations.push({
      file,
      line: precedingText.split('\n').length,
      key: lastLine.trim().replace(/:\s*$/, '') || '<unknown>',
      proxied: /^(?:\s*\.\s*\w+\([^)]*\))*/.exec(source.slice(closeParenIndex + 1))?.[0].includes('.proxy()') ?? false,
      parameters: parseFactoryParameters(source.slice(openParenIndex + 1, closeParenIndex)),
    })
  }
  return registrations
}

function collectDiKeys(files: string[]): Set<string> {
  const keys = new Set<string>(externallyRegisteredDiKeys)
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    if (!/as(?:Function|Class|Value)\s*\(/.test(source)) continue
    for (const match of source.matchAll(
      /(?:^|[\s{,(])(['"`]?)([A-Za-z_$][\w$]*)\1\s*:\s*as(?:Function|Class|Value)\s*\(/g,
    )) {
      keys.add(match[2])
    }
    // `{ [SOME_TOKEN]: asFunction(...) }` with `const SOME_TOKEN = 'someService'`
    // declared in the same file is the type-safe way to register a token.
    for (const match of source.matchAll(
      /\[\s*([A-Za-z_$][\w$]*)\s*\]\s*:\s*as(?:Function|Class|Value)\s*\(/g,
    )) {
      const literal = source.match(
        new RegExp(`\\b${match[1]}\\s*(?::[^=]+)?=\\s*(['"\`])([^'"\`]+)\\1`),
      )
      if (literal) keys.add(literal[2])
    }
  }
  return keys
}

function describeRegistration({ file, line, key }: Registration): string {
  return `${path.relative(repoRoot, file)}:${line} (${key})`
}

describe('module DI registrations vs CLASSIC injection mode', () => {
  const sourceFiles = listSourceFiles()
  const registrations = sourceFiles.flatMap(collectRegistrations)
  const diKeys = collectDiKeys(sourceFiles)

  it('finds the asFunction registrations it is meant to guard', () => {
    expect(registrations.length).toBeGreaterThan(20)
    expect(diKeys.has('em')).toBe(true)
  })

  it('every factory with a destructured parameter chains .proxy()', () => {
    const violations = registrations
      .filter((registration) => !registration.proxied)
      .filter((registration) => registration.parameters?.some((parameter) => parameter.destructured))
      .map((registration) => `${describeRegistration(registration)} destructures its parameter without .proxy()`)

    expect(violations.join('\n')).toBe('')
  })

  it('every classic factory parameter names a registered DI key', () => {
    const violations = registrations
      .filter((registration) => !registration.proxied)
      .flatMap((registration) =>
        (registration.parameters ?? [])
          .filter((parameter) => !parameter.destructured && !diKeys.has(parameter.name))
          .map(
            (parameter) =>
              `${describeRegistration(registration)} takes '${parameter.name}', which is not a registered DI key`,
          ),
      )

    expect(violations.join('\n')).toBe('')
  })

  it('every optional classic factory parameter declares a default value', () => {
    const violations = registrations
      .filter((registration) => !registration.proxied)
      .flatMap((registration) =>
        (registration.parameters ?? [])
          .filter((parameter) => parameter.typescriptOptional && !parameter.hasDefault)
          .map(
            (parameter) =>
              `${describeRegistration(registration)} marks '${parameter.name}' optional with '?', which transpiles away — give it a default value instead`,
          ),
      )

    expect(violations.join('\n')).toBe('')
  })
})

// Executable statement of the awilix semantics the rules above encode, so an
// awilix upgrade that changes them fails here rather than in production.
describe('awilix CLASSIC injection semantics', () => {
  const buildContainer = () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC })
    container.register({ em: asValue({ id: 'em' }) })
    return container
  }

  it('injects undefined into a destructured factory', () => {
    const container = buildContainer()
    container.register({ probe: asFunction(({ em }: { em: unknown }) => ({ em })) })
    expect(container.resolve<{ em: unknown }>('probe').em).toBeUndefined()
  })

  it('throws for a cradle-shaped factory', () => {
    const container = buildContainer()
    container.register({ probe: asFunction((cradle: { em: unknown }) => ({ em: cradle.em })) })
    expect(() => container.resolve('probe')).toThrow(/Could not resolve 'cradle'/)
  })

  it('injects the cradle once the registration chains .proxy()', () => {
    const container = buildContainer()
    container.register({
      destructuredProbe: asFunction(({ em }: { em: unknown }) => ({ em })).proxy(),
      cradleProbe: asFunction((cradle: { em: unknown }) => ({ em: cradle.em })).proxy(),
    })
    expect(container.resolve<{ em: unknown }>('destructuredProbe').em).toBe(container.resolve('em'))
    expect(container.resolve<{ em: unknown }>('cradleProbe').em).toBe(container.resolve('em'))
  })

  it('treats a parameter as optional only when it declares a default value', () => {
    const container = buildContainer()
    container.register({
      // Mirrors what TypeScript emits for `(em, cache?: Cache | null)`.
      erasedOptional: asFunction((em: unknown, cache: unknown) => ({ em, cache })),
      runtimeDefault: asFunction((em: unknown, cache: unknown = null) => ({ em, cache })),
    })
    expect(() => container.resolve('erasedOptional')).toThrow(/Could not resolve 'cache'/)
    expect(container.resolve<{ cache: unknown }>('runtimeDefault').cache).toBeNull()
  })
})
