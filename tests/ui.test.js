/**
 * The dashboard is one HTML file with an inline script. A syntax error anywhere
 * in it stops the whole page from running — every board renders empty — yet no
 * server test would notice. This compiles each inline script without running it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const page of ['index.html', 'login.html', 'charts.html']) {
  test(`public/${page}: inline scripts compile`, () => {
    const html = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    for (const [i, code] of blocks.entries()) {
      assert.doesNotThrow(() => new vm.Script(code, { filename: `${page}#script${i}` }), `${page} script block ${i}`);
    }
  });
}
