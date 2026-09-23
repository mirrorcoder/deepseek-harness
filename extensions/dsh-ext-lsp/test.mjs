// The LSP bundle's wiring. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-lsp/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')

test('the bundle mounts the seam, the provider and the tool', () => {
  for (const name of ['@deepseek-ai/dsh-lsp', '@deepseek-ai/dsh-lsp-stdio', '@deepseek-ai/dsh-tool-lsp']) {
    assert.ok(patch.includes(`name: '${name}'`), `${name} missing`)
  }
})

test('python and typescript files each have a server', () => {
  assert.match(patch, /'\.py': python/)
  assert.match(patch, /'\.ts': typescript/)
  assert.match(patch, /'\.tsx': typescriptreact/)
})

test('every configured server is actually on the PATH of this image', () => {
  // A missing executable does not fail loudly: the provider refuses to
  // register, and the `lsp` tool simply answers "unavailable" forever.
  for (const command of ['pyright-langserver', 'typescript-language-server']) {
    const found = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' })
    if (found.status !== 0 && process.env.DSH_HOME === undefined) continue // outside the image
    assert.equal(found.status, 0, `${command} is not installed in the image`)
  }
})
