'use strict';
// Gerador da página de entrega dos Marcos 4/5: parser do log, saneamento e classificação.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLog, resultadoDe } = require('../scripts/lib/entregaMarco45/parseLog');
const { sanearLog } = require('../scripts/lib/sanearLog');
const R = require('../scripts/lib/entregaMarco45/render');

const LOG = [
  '# Nayara One — log de exemplo', '# commit avaliado (branch): 0123456789abcdef0123456789abcdef01234567', '#',
  '{"level":30,"req":{"headers":{"authorization":"Bearer eyJabc.def.ghi"}}}',
  '✔ teste que passa (12.5ms)', '✖ teste que falha (3ms)', '﹣ teste pulado (0.1ms) # SKIP motivo', '✔ nome repetido (1ms)', '✔ nome repetido (2ms)',
  'ℹ tests 5', 'ℹ pass 3', 'ℹ fail 1',
].join('\n');

test('sanearLog remove log JSON e segredos, mantém cada linha de resultado e registra os dois SHA-256', () => {
  const r = sanearLog(LOG, { nomeOriginal: 'x.log' });
  assert.equal(r.jsonRemovidas, 1);
  assert.ok(!/eyJ|Bearer ey/.test(r.texto.split('\n').filter((l) => !l.startsWith('#')).join('\n')));
  for (const l of LOG.split('\n').filter((x) => /^(✔|✖|﹣|ℹ)/.test(x))) assert.ok(r.texto.includes(l), l);
  assert.match(r.texto, new RegExp(r.shaOriginal));
  assert.notEqual(r.shaOriginal, r.shaSaneado);
});

test('parseLog lê status e duração de cada teste, o commit do cabeçalho e o resumo', () => {
  const p = parseLog(LOG);
  assert.equal(p.commit, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(resultadoDe(p, 'teste que passa').status, 'pass');
  assert.equal(resultadoDe(p, 'teste que passa').duracaoMs, 12.5);
  assert.equal(resultadoDe(p, 'teste que falha').status, 'fail');
  assert.equal(resultadoDe(p, 'teste pulado').status, 'skip');
  assert.equal(resultadoDe(p, 'nome repetido').ocorrencias, 2);
  assert.equal(resultadoDe(p, 'inexistente'), null);
  assert.equal(p.resumo.tests, 5);
});

test('classificação: sem log tudo aguarda; com log, ausente/falhou/bloqueado/aprovado; grupo = pior categoria', () => {
  assert.equal(R.classificarTeste(null, 'qualquer').cat, 'aguardando');
  const p = parseLog(LOG);
  assert.equal(R.classificarTeste(p, 'teste que passa').cat, 'aprovado');
  assert.equal(R.classificarTeste(p, 'teste que falha').cat, 'falhou');
  assert.equal(R.classificarTeste(p, 'teste pulado').cat, 'bloqueado');
  assert.equal(R.classificarTeste(p, 'nao existe').cat, 'ausente');
  assert.equal(R.pior(['aprovado', 'bloqueado']), 'bloqueado');
  assert.equal(R.pior(['aprovado', 'falhou', 'aguardando']), 'falhou');
  assert.equal(R.pior(['aprovado', 'aprovado']), 'aprovado');
});
