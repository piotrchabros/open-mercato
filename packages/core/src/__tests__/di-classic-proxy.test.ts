import fs from 'node:fs'
import path from 'node:path'

// The request container is built in Awilix CLASSIC injection mode
// (packages/shared/src/lib/di/container.ts). CLASSIC resolves dependencies by
// parsing parameter NAMES, so a factory that destructures its first parameter —
// asFunction(({ em }) => ...) — receives the positionally-resolved dependency as
// the object being destructured and every destructured binding comes out
// undefined. A renamed binding — asFunction(({ em: entityManager }) => ...) — is
// parsed under its NEW name, and a factory taking a single parameter named `cradle`
// is looked up as a registration literally called `cradle`; both THROW at
// resolution. `packages/shared/src/lib/di/__tests__/classic-injection-mode.test.ts`
// pins each of those behaviours. See issues #4201 and #33.
//
// Both shapes must therefore opt into PROXY resolution per registration by
// chaining `.proxy()` (plain named parameters — `asFunction((em) => ...)` —
// are the other correct form and need nothing).
//
// This guard covers every workspace source root plus the published docs, because
// the pattern spreads by copy-paste: a `.mdx` snippet or a JSDoc usage example
// that omits `.proxy()` teaches third-party module authors the broken form.
//
// Known limitation: it reads INLINE factories only. `asFunction(createThing)`, where
// the factory lives in another file, is not followed — those must be reviewed by hand.

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')

const SOURCE_ROOTS = [
  path.join(repoRoot, 'packages'),
  path.join(repoRoot, 'apps'),
  path.join(repoRoot, 'external', 'official-modules', 'packages'),
]

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.mercato',
  '__tests__',
])

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.md', '.mdx']

function collectSourceFiles(directory: string, collected: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return collected
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      collectSourceFiles(entryPath, collected)
      continue
    }
    if (!entry.isFile()) continue
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    if (!SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue
    collected.push(entryPath)
  }
  return collected
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

/** Extracts the factory's parameter list, or null when the argument is not an inline function. */
function readFactoryParameters(factoryArgument: string): string | null {
  const withoutAsync = factoryArgument.startsWith('async')
    ? factoryArgument.slice('async'.length).trimStart()
    : factoryArgument
  const openParenIndex = withoutAsync.startsWith('function')
    ? withoutAsync.indexOf('(')
    : withoutAsync.startsWith('(')
      ? 0
      : -1
  if (openParenIndex === -1) return null
  const closeParenIndex = findMatchingParen(withoutAsync, openParenIndex)
  if (closeParenIndex === -1) return null
  return withoutAsync.slice(openParenIndex + 1, closeParenIndex).trim()
}

function requiresProxy(parameters: string): boolean {
  if (parameters.startsWith('{')) return true
  const firstParameterName = parameters.split(',')[0].split(':')[0].trim()
  return firstParameterName === 'cradle'
}

// Documentation that deliberately shows the broken shapes (to explain why they are
// broken) brackets them with `di-classic-proxy:allow-start` / `-end` markers —
// `// ...` in TypeScript, `{/* ... */}` in MDX, which Docusaurus strips from the page.
const ALLOW_START = 'di-classic-proxy:allow-start'
const ALLOW_END = 'di-classic-proxy:allow-end'

function buildAllowedRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let searchFrom = 0
  for (;;) {
    const start = source.indexOf(ALLOW_START, searchFrom)
    if (start === -1) break
    const end = source.indexOf(ALLOW_END, start)
    ranges.push([start, end === -1 ? source.length : end])
    if (end === -1) break
    searchFrom = end + ALLOW_END.length
  }
  return ranges
}

type Violation = { file: string; line: number; snippet: string }

function findRegistrationsMissingProxy(file: string): Violation[] {
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes('asFunction')) return []
  const allowedRanges = buildAllowedRanges(source)
  const violations: Violation[] = []
  const registration = /asFunction\s*\(/g
  let match: RegExpExecArray | null
  while ((match = registration.exec(source)) !== null) {
    const matchIndex = match.index
    if (allowedRanges.some(([start, end]) => matchIndex >= start && matchIndex <= end)) continue
    const openParenIndex = matchIndex + match[0].length - 1
    const closeParenIndex = findMatchingParen(source, openParenIndex)
    if (closeParenIndex === -1) continue
    const parameters = readFactoryParameters(source.slice(openParenIndex + 1, closeParenIndex).trim())
    if (parameters === null || !requiresProxy(parameters)) continue
    const modifierChain = source.slice(closeParenIndex + 1).match(/^(?:\s*\.\s*\w+\([^()]*\))*/)?.[0] ?? ''
    if (/\.\s*proxy\(\)/.test(modifierChain)) continue
    violations.push({
      file,
      line: source.slice(0, matchIndex).split('\n').length,
      snippet: source.slice(matchIndex, closeParenIndex + 1).slice(0, 120),
    })
  }
  return violations
}

describe('Awilix registrations vs CLASSIC injection mode', () => {
  const sourceFiles = SOURCE_ROOTS.flatMap((root) => collectSourceFiles(root))

  it('reaches beyond `packages/<pkg>/src/modules/<module>/di.ts`', () => {
    // The predecessor of this guard only walked that one shape, so app modules,
    // package-root `src/di.ts` files and the create-app template went unchecked.
    const scannedDiFiles = sourceFiles
      .filter((file) => path.basename(file) === 'di.ts')
      .map((file) => path.relative(repoRoot, file))
    expect(scannedDiFiles.length).toBeGreaterThan(0)
    const coreModuleShape = /^packages\/[^/]+\/src\/modules\/[^/]+\/di\.ts$/
    expect(scannedDiFiles.filter((file) => !coreModuleShape.test(file)).length).toBeGreaterThan(0)
    expect(sourceFiles.some((file) => file.endsWith('.mdx'))).toBe(true)
  })

  it('every asFunction factory that destructures or names its parameter `cradle` chains .proxy()', () => {
    const violations = sourceFiles.flatMap(findRegistrationsMissingProxy)
    const report = violations
      .map(({ file, line, snippet }) =>
        `${path.relative(repoRoot, file)}:${line}: ${snippet.replace(/\s+/g, ' ')}`,
      )
      .join('\n')

    expect(report).toBe('')
  })
})
