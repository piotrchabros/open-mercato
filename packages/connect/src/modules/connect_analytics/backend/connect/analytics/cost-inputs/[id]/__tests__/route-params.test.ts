import fs from 'node:fs'
import path from 'node:path'

describe('cost input edit route parameters', () => {
  it('uses the dynamic parameters injected by the backend module router', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../page.tsx'), 'utf8')

    expect(source).toContain('EditConnectCostInputPage({ params }')
    expect(source).not.toContain('useParams')
    expect(source).toContain('setLoading(false)')
  })
})
