'use strict';

// Matriz do Marco 5 (§6 "Modelo publicado não é editado; nova versão é criada"): a PRÉVIA do modelo mostra a mesma
// versão que GERA contrato (a publicada), mesmo com um rascunho em edição; o rascunho só aparece se pedido
// (versao=rascunho) ou se o modelo nunca foi publicado. Achado do E2E do Front (prévia ≠ documento gerado). HTTP real.
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

test('§6: a prévia do modelo usa a versão publicada (a que gera contrato); o rascunho só quando pedido ou sem publicada', async (t) => {
  if (pular) return t.skip(pular);
  const code = `PV-${h.sfx()}`;
  const c1 = await h.http('A:maker', 'POST', '/legal/clauses', { code, title: 'Objeto', bodyText: 'Cláusula da versão publicada.', category: 'GENERAL' });
  const tpl = await h.http('A:maker', 'POST', '/legal/contract-templates', { name: `Modelo ${code}`, contractType: 'LEASE_RESIDENTIAL' });
  await h.http('A:maker', 'POST', `/legal/contract-templates/${tpl.data.id}/clauses`, { contractClauseId: c1.data.id });

  const soRascunho = await h.http('A:leitura', 'POST', `/legal/contract-templates/${tpl.data.id}/render`, {});
  assert.equal(soRascunho.status, 200);
  assert.equal(soRascunho.data.templateVersionStatus, 'DRAFT', 'sem versão publicada, a prévia mostra o rascunho e diz isso');

  assert.equal((await h.http('A:checker', 'POST', `/legal/contract-templates/${tpl.data.id}/publish`, {})).status, 200);
  const c2 = await h.http('A:maker', 'POST', '/legal/clauses', { code: `${code}-B`, title: 'Foro', bodyText: 'Cláusula só do rascunho.', category: 'GENERAL' });
  await h.http('A:maker', 'POST', `/legal/contract-templates/${tpl.data.id}/clauses`, { contractClauseId: c2.data.id });

  const previa = await h.http('A:leitura', 'POST', `/legal/contract-templates/${tpl.data.id}/render`, {});
  assert.equal(previa.status, 200);
  assert.equal(previa.data.templateVersionStatus, 'PUBLISHED');
  assert.equal(previa.data.templateVersionNumber, 1);
  assert.deepEqual(previa.data.clauses.map((c) => c.code), [code], 'a prévia mostra só a cláusula da versão publicada');

  const doRascunho = await h.http('A:leitura', 'POST', `/legal/contract-templates/${tpl.data.id}/render?versao=rascunho`, {});
  assert.equal(doRascunho.data.templateVersionStatus, 'DRAFT');
  assert.deepEqual(doRascunho.data.clauses.map((c) => c.code).sort(), [code, `${code}-B`].sort(), 'pedida explicitamente, a prévia do rascunho mostra a cláusula nova');
});
