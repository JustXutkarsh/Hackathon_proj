import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('dev server survives missing assets and serves deep links with absolute assets', {timeout:10000}, async () => {
  const child = spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  try {
    const [output] = await once(child.stdout,'data');
    const origin = output.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    assert.equal((await fetch(origin+'/missing-favicon.ico')).status,404);
    for (const path of ['/','/local','/plan/11111111-1111-4111-8111-111111111111']) {
      const response = await fetch(origin+path);
      assert.equal(response.status,200);
      assert.match(await response.text(),/src="\/entry.js"/);
    }
    const css = await fetch(origin+'/styles.css');
    assert.equal(css.headers.get('content-type'),'text/css');
    assert.equal(css.status,200);
  } finally {
    const closed = once(child,'exit'); child.kill(); await closed;
  }
});
