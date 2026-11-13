'use strict';

// Verificação independente do Marco 9, rodada 8 (12/11/2026), item 5 (DI-M9R-26): a bateria declarada como completa rodava o glob do `npm test`, que
// deixava de fora 32 dos 1.565 arquivos de teste (test/ai/m9d00*, test/integrations/<pasta>/*, ...). Um deles (redaction.tempoLinear) quebrou na
// rodada 7 sem ninguém perceber. Agora o `npm test` roda TODOS os arquivos `*.test.js` de test/, e este teste garante que continue assim: todo arquivo
// de teste versionado é coberto por um padrão do script.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..');

/** Padrão de arquivo do `node --test` (`*` sem barra, `**` qualquer coisa) como expressão regular. */
const comoRegex = (padrao) => new RegExp(`^${padrao.split('**/').map((parte) => parte.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('(?:.*/)?')}$`);

test('o npm test roda todos os arquivos *.test.js versionados em test/', () => {
  const script = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).scripts.test;
  const padroes = script.replace(/^node --test\s+/, '').match(/"[^"]+"|\S+/g).map((p) => p.replace(/^"|"$/g, '')).filter((p) => !p.startsWith('-'));
  const arquivos = execFileSync('git', ['ls-files', 'test'], { cwd: RAIZ, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.test.js'));
  assert.ok(arquivos.length > 1500, `arquivos de teste: ${arquivos.length}`);
  const regexes = padroes.map(comoRegex);
  const fora = arquivos.filter((f) => !regexes.some((r) => r.test(f)));
  assert.deepEqual(fora, [], `arquivos de teste fora do npm test (${fora.length})`);
});
