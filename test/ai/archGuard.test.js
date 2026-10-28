'use strict';

// M9-D001: teste de arquitetura da NAY. Prova por ausência (AI-002, AI-004 e "Não improvisar"):
// src/modules/ai/** não tem SQL livre, shell, eval, escrita em disco, secret manager, adapter
// bancário de execução, conexão de superusuário nem SDK de fornecedor fora de providers/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const guard = require('../../scripts/lib/aiArchGuard');

const FIX = path.join(__dirname, 'fixtures');
const REGRAS_ESPERADAS = ['sql-livre', 'shell', 'vm', 'eval', 'fs-escrita', 'sdk-fornecedor', 'secret-manager', 'adapter-bancario', 'superusuario'];

test('archGuard: src/modules/ai/** e o resto de src/ não violam nenhuma regra', () => {
  const v = [...guard.varrer(), ...guard.varrerSdkFornecedorNoRestoDoCodigo()];
  assert.equal(v.length, 0, `violações:\n${guard.formatar(v)}`);
});

test('archGuard: a árvore src/modules/ai existe (a NAY entregue é o que o guarda varre)', () => {
  const fs = require('node:fs');
  assert.ok(fs.existsSync(guard.RAIZ_PADRAO), 'src/modules/ai/ não existe: o guarda não pode provar ausência sobre uma árvore inexistente (M9-D003).');
  assert.ok(guard.listarArquivos(guard.RAIZ_PADRAO).length > 0, 'src/modules/ai/ está vazia.');
});

test('archGuard_reprova_fixture_violadora', () => {
  const v = guard.varrer(path.join(FIX, 'violadora'));
  const regras = new Set(v.map((x) => x.regra));
  for (const r of REGRAS_ESPERADAS) assert.ok(regras.has(r), `a fixture violadora deveria disparar a regra ${r}; disparou: ${[...regras].join(', ')}`);
  for (const x of v) {
    assert.match(x.arquivo, /ferramentaVioladora\.js$/, 'cada achado cita o arquivo');
    assert.ok(Number.isInteger(x.linha) && x.linha > 0, 'cada achado cita a linha');
  }
  // o script de CI sai com código 1 e imprime arquivo:linha
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'ai-arch-guard.js'), '--raiz', path.join(FIX, 'violadora')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ferramentaVioladora\.js:\d+ \[sql-livre\]/);
});

test('archGuard: fixture limpa (SDK em providers/ e consulta em readmodels/) passa, e o script de CI sai com 0', () => {
  assert.deepEqual(guard.varrer(path.join(FIX, 'limpa')), []);
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'ai-arch-guard.js'), '--raiz', path.join(FIX, 'limpa')], { encoding: 'utf8' });
  assert.match(out, /0 violações/);
});

test('archGuard: comentários não geram falso positivo e a linha reportada é a do código', () => {
  const limpo = guard.limparComentarios("// eval(x)\n/* child_process\n sequelize.query( */\nconst a = 1;\n");
  assert.equal(limpo.split('\n').length, 5);
  assert.ok(!/eval|query|child_process/.test(limpo));
});
