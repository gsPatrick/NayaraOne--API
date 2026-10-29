'use strict';

// M9-D046 — carga da NAY com o provider sandbox: várias empresas e pessoas em paralelo; zero vazamento entre empresas, zero ultrapassagem de
// orçamento por concorrência, zero run preso em RUNNING e zero execução duplicada de tool ou de aprovação. Grava de verdade: banco descartável.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { executarCarga, F } = require('../../../scripts/ai-load/executar');
const inv = require('../../../scripts/ai-load/invariantes');
const { preparar } = require('../_helpers/iaDrill');

after(async () => { await F.sequelize.close(); });

test('m9d046_carga_sem_vazamento_nem_estouro_de_orcamento', async () => {
  assert.equal(process.env.DISPOSABLE_DB, '1', 'a carga grava de verdade: roda só no banco descartável');
  const { tenantA, tenantB } = await preparar();
  const r = await executarCarga([tenantA, tenantB], { usuariosPorEmpresa: 2, execucoesPorUsuario: 3, aceitesSimultaneos: 4, repeticoesDaToolCall: 4 });
  assert.deepEqual(r.violacoes, { vazamento: [], estouroDeOrcamento: [], runPresoEmRunning: [], execucaoDuplicada: [] });
  assert.equal(r.ok, true);
  assert.equal(r.empresas, 2);
  assert.deepEqual(r.aceitosPorEmpresa, [6, 6], 'cabem exatamente 6 runs de R$ 10 no limite de R$ 60 de cada empresa');
  assert.equal(r.recusadosPorOrcamento, 0, '6 pedidos por empresa cabem no limite: nenhum recusado neste volume');
  assert.equal(r.duplicidade.execucoesReais, 1);
  assert.equal(r.duplicidade.pagamentos, 1);
});

test('m9d046_carga_orcamento_estoura_sob_concorrencia_e_so_o_que_coube_passa', async () => {
  const { tenantA, tenantB } = await preparar();
  const r = await executarCarga([tenantA, tenantB], { usuariosPorEmpresa: 3, execucoesPorUsuario: 4, aceitesSimultaneos: 3, repeticoesDaToolCall: 3 });
  assert.deepEqual(r.violacoes.estouroDeOrcamento, []);
  assert.deepEqual(r.aceitosPorEmpresa, [6, 6], '12 pedidos concorrentes por empresa: só os 6 que cabem em R$ 60');
  assert.equal(r.recusadosPorOrcamento, 12, 'os outros 12 (6 por empresa) recebem 429 AI_BUDGET_EXHAUSTED');
  assert.equal(r.ok, true);
});

test('m9d046_carga_as_invariantes_detectam_violacao', async () => {
  // Prova de que as checagens não são tautológicas: dados com violação são reprovados.
  assert.deepEqual(inv.duplicados({ propostas: 2, linhasDeToolCall: 1, execucoesReais: 2, pagamentos: 2, aceitesConcluidos: 3, aceitesEnviados: 5, recusados: ['X'] }).length, 4);
  assert.deepEqual(inv.duplicados({ propostas: 1, linhasDeToolCall: 1, execucoesReais: 1, pagamentos: 1, aceitesConcluidos: 5, aceitesEnviados: 5, recusados: [] }), []);
});
