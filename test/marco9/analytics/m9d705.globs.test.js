'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expandirGlobs } = require('../../../scripts/analytics/ci/run');
const { ETAPAS } = require('../../../scripts/analytics/ci/etapas');

// O CI roda no Node 20, cujo `node --test` não expande glob e o spawn sem shell também não: sem a expansão a etapa 4 reprovava com "Could not find ...*.test.js".
test('m9d705 argumento com glob vira a lista de arquivos existentes e opção passa intacta', () => {
  const r = expandirGlobs(['--test', 'test/marco9/analytics/m9d705.*.test.js']);
  assert.equal(r[0], '--test');
  assert.ok(r.length >= 3 && r.every((a, i) => i === 0 || /^test\/marco9\/analytics\/m9d705\.[a-zA-Z]+\.test\.js$/.test(a)), r.join(' '));
  assert.ok(r.includes('test/marco9/analytics/m9d705.globs.test.js'));
});

test('m9d705 glob sem nenhum arquivo segue como veio (o node --test reprova, nunca passa vazio)', () => {
  assert.deepEqual(expandirGlobs(['test/analytics/naoExiste/*.test.js']), ['test/analytics/naoExiste/*.test.js']);
  assert.deepEqual(expandirGlobs(['--test-name-pattern', 'adv(01|02) ']), ['--test-name-pattern', 'adv(01|02) ']);
});

test('m9d705 todo glob das etapas expande para ao menos um arquivo', () => {
  for (const e of ETAPAS) for (const c of e.comandos) for (const a of c.args.filter((x) => x.includes('*') && !x.startsWith('-'))) {
    assert.notDeepEqual(expandirGlobs([a]), [a], `etapa ${e.n}: ${a} não casa com arquivo algum`);
  }
});
