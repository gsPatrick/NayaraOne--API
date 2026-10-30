'use strict';

// Marco 9, M9-D253 — Definition of Done do bloco de integrações: scripts/integrationDod.js, exit 0 só com os 15 itens com evidência e a matriz íntegra.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ITENS } = require('../../../scripts/int-ci/lib/dodItens');
const { avaliar, executar, CODIGO_FALTA, MENSAGEM_FALTA } = require('../../../scripts/int-ci/lib/dod');
const { ambienteVerde } = require('../_helpers/m9d253Env');

const RAIZ = path.join(__dirname, '..', '..', '..');
const mdVerde = () => fs.readFileSync(path.join(RAIZ, 'docs/integrations/MATRIZ_INT.md'), 'utf8');

test('dod_script_falha_quando_item_falta', () => {
  assert.equal(ITENS.length, 15);
  assert.deepEqual(ITENS.map((i) => i.n), Array.from({ length: 15 }, (_, i) => i + 1));
  for (const item of ITENS) {
    const { amb, arquivos } = ambienteVerde();
    const alvo = item.evidencias.find((e) => e.arquivo);
    if (!alvo) continue;
    arquivos.delete(alvo.arquivo);
    const r = executar(ITENS, amb, mdVerde());
    assert.equal(r.code, 1, `item ${item.n} sem ${alvo.arquivo} deveria reprovar`);
    assert.match(r.stderr, new RegExp(`${CODIGO_FALTA}.*item ${item.n}\\b`), 'o código e o item aparecem');
    assert.ok(r.stderr.includes(MENSAGEM_FALTA));
    assert.match(r.stdout, /14 de 15 itens/);
  }
  // Teste nomeado ausente, contrato vermelho, runbook faltando, família sem sandbox e adversarial ausente também reprovam o item que os usa.
  const casos = [
    [{ existeTeste: (n) => n !== 'retry_validation_nunca_repete' }, 5],
    [{ contratosFaltando: () => ['bank-sandbox: sem relatório'] }, 9],
    [{ runbooksFaltando: () => ['bank-sandbox'] }, 8],
    [{ familiasSemSandbox: () => ['SOCIAL'] }, 2],
    [{ adversariais: () => ({ ok: false, problemas: [], ausentes: [{ nome: 'adv_x', item: 3, parte: 1 }] }) }, 12],
  ];
  for (const [mexer, n] of casos) {
    const r = executar(ITENS, ambienteVerde(mexer).amb, mdVerde());
    assert.equal(r.code, 1, `item ${n}`);
    assert.match(r.stderr, new RegExp(`item ${n}\\b`));
  }
  // Matriz quebrada reprova mesmo com os 15 itens verdes.
  const r = executar(ITENS, ambienteVerde().amb, mdVerde().split('\n').filter((l) => !l.startsWith('| INT-003')).join('\n'));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /matriz/i);
});

test('dod_script_passa_com_tudo_verde', () => {
  const { amb } = ambienteVerde();
  const r = executar(ITENS, amb, mdVerde());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /15 de 15 itens/);
  assert.match(r.stdout, /15 de 15 princípios/);
  assert.equal(r.stderr, '');
  for (const it of ITENS) assert.ok(r.stdout.includes(it.livro), `item ${it.n} impresso`);
  assert.match(r.stdout, /INT-013 Provider swap/, 'a matriz é impressa');
  assert.equal(avaliar(ITENS, amb).ok, true);
  // Executado de verdade (processo, saída e código): numa pasta sem nada, reprova todos os 15 itens e não imprime caminho absoluto de máquina.
  const vazia = fs.mkdtempSync(path.join(os.tmpdir(), 'dod-'));
  const p = spawnSync('node', ['scripts/integrationDod.js', '--raiz', vazia], { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.ok(p.stderr.includes(CODIGO_FALTA));
  assert.ok(!p.stdout.includes(vazia) && !p.stderr.includes(vazia) && !p.stdout.includes(RAIZ), 'sem caminho absoluto na saída');
});

test('dod_inclui_autochecagem_de_integracoes_calculada', () => {
  const item15 = ITENS.find((i) => i.n === 15);
  assert.match(item15.livro, /Autochecagem/i);
  assert.ok(item15.evidencias.some((e) => e.arquivo === 'scripts/integrationAutocheck.js'), 'o item 15 é o script da M9-D258');
  const { amb, arquivos } = ambienteVerde();
  assert.equal(executar(ITENS, amb, mdVerde()).code, 0);
  arquivos.delete('scripts/integrationAutocheck.js');
  const r = executar(ITENS, amb, mdVerde());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /item 15\b/);
  // Item 14 é a liberação por provider da M9-D256.
  assert.ok(ITENS.find((i) => i.n === 14).evidencias.some((e) => e.arquivo === 'src/features/integrations/registry/releaseGate.js'));
});

test('dod_executa_autochecagem_quando_ela_existe', () => {
  // Com o script da M9-D258 presente, o DoD o executa (exit 1 dele reprova o item 15); o executor é injetado.
  const { amb } = ambienteVerde({ autochecagem: () => ({ code: 1, output: 'pergunta 2 NÃO' }) });
  const r = executar(ITENS, amb, mdVerde());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /item 15\b/);
  assert.match(r.stderr, /autochecagem/i);
  const verde = ambienteVerde({ autochecagem: () => ({ code: 0, output: 'SIM' }) });
  assert.equal(executar(ITENS, verde.amb, mdVerde()).code, 0);
});
