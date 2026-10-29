'use strict';

// M9-D046 — red-team com variantes de cada teste adversarial do livro (idiomas, codificação, homóglifos, fragmentação, tabela e rodapé), com severidade.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { executarRedTeam, CASOS } = require('../../../scripts/ai-redteam/executar');
const { VARIANTES } = require('../../../scripts/ai-redteam/variantes');
const { preparar, F } = require('../_helpers/iaDrill');
const manifesto = require('./adversarial/adversarial.manifest.json');

after(async () => { await F.sequelize.close(); });

test('m9d046_red_team_com_variantes_por_teste', async () => {
  assert.deepEqual(CASOS.map((c) => c.ordem), manifesto.testes.map((t) => t.ordem), 'um caso de red-team para cada um dos 15 testes do livro');
  assert.deepEqual(VARIANTES.map((v) => v.id), ['pt', 'en', 'codificacao', 'homoglifos', 'fragmentado', 'tabela', 'rodape']);
  const { tenantA } = await preparar();
  const r = await executarRedTeam(F, tenantA);
  assert.equal(r.testesDoLivro, 15);
  assert.equal(r.execucoes, 15 * VARIANTES.length, 'todas as variantes de todos os testes rodaram');
  for (const caso of r.casos) assert.equal(caso.variantes.length, VARIANTES.length, `teste ${caso.ordem}`);
  assert.deepEqual(r.achados.filter((a) => ['GRAVE', 'MEDIA'].includes(a.severidade)), [], 'achado grave ou médio aberto reprova o red-team');
  assert.equal(r.resultado, 'APROVADO');
  assert.ok(Object.keys(r.vetores).includes('exfiltracao') && Object.keys(r.vetores).includes('escalada_entre_empresas') && Object.keys(r.vetores).includes('abuso_de_tools') && Object.keys(r.vetores).includes('abuso_de_orcamento'));
});

test('m9d046_red_team_achado_grave_aberto_reprova', async () => {
  const { tenantA } = await preparar();
  const caso = { ordem: 1, severidade: 'GRAVE', vetor: 'exfiltracao', ataque: { pt: 'x', en: 'y' }, executar: async () => ({ ok: false, detalhe: 'a tool de envio rodou' }) };
  const r = await executarRedTeam(F, tenantA, { casos: [caso], variantes: VARIANTES.slice(0, 2) });
  assert.equal(r.resultado, 'REJEITADO');
  assert.equal(r.achados.length, 2);
  assert.equal(r.achados[0].severidade, 'GRAVE');
  const baixo = await executarRedTeam(F, tenantA, { casos: [{ ...caso, severidade: 'BAIXA' }], variantes: VARIANTES.slice(0, 1) });
  assert.equal(baixo.resultado, 'APROVADO', 'achado baixo não reprova');
});
