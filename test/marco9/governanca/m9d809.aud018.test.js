'use strict';

// M9-D809 — AUD-018 (JUR-011): prova jurídica não é apagada. Nenhuma rota nem serviço de exclusão física de contrato, assinatura, vistoria, dossiê, processo, notificação, aditivo ou
// entrega de chaves, e o inventário de ações destrutivas da M9-D852 não lista exclusão física deles. A metade do descarte (M9-D912) usa o banco descartável: contrato em legal hold fica em blocked_by_hold.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'segredo-de-teste-m9d809';
const skip = DISPOSABLE ? false : SKIP_DISPOSABLE;

// Recursos do escopo jurídico (JUR-011): contratos, assinaturas, vistorias e provas críticas (dossiê, processo, notificação, aditivo, entrega de chaves, prazo, versão).
const ESCOPO = /\/legal\/(contracts|signatures|inspections|evidence-packages|cases|notices|amendments|key-deliveries|deadlines|contract-versions)\b/;
// Caminhos da árvore do Guia do Marco 5, §2 (src/modules/legal).
const SERVICOS = ['contracts/application/contract', 'contracts/application/contractVersions', 'contracts/application/contractAmendments', 'signatures/signature', 'inspections/inspection',
  'cases/evidence-package', 'cases/legal-case', 'cases/deadline', 'contracts/application/notices', 'leasing/key-delivery'];

after(async () => { if (DISPOSABLE) await require('../../../src/models').sequelize.close(); });

test('m9d809 AUD-018 retention apply pula registro do escopo jurídico e nenhuma rota de exclusão física dele existe no inventário', { skip }, async () => {
  const { allRoutes } = require('../_helpers/m9d852Rotas');
  const D = require('../../../src/shared/destructive-actions');

  // 1) nenhuma rota DELETE do escopo jurídico (a única DELETE do Jurídico é a de garantia, que não é prova crítica e é guardada pela confirmação)
  const deletes = allRoutes().filter((r) => r.methods.includes('DELETE') && /^\/legal\//.test(r.path));
  assert.deepEqual(deletes.filter((r) => ESCOPO.test(r.path)).map((r) => r.path), [], 'rota de exclusão física no escopo jurídico');
  assert.ok(deletes.length >= 1, 'a varredura enxerga as rotas DELETE do Jurídico (não é um passe vazio)');

  // 2) o inventário de ações destrutivas (M9-D852) não lista exclusão física desses recursos
  const fisicas = D.inventory.all().filter((a) => a.method === 'DELETE' && ESCOPO.test(a.route || ''));
  assert.deepEqual(fisicas.map((a) => a.key), []);

  // 3) nenhum serviço do escopo exporta função de exclusão física
  for (const nome of SERVICOS) {
    const exportadas = Object.keys(require(`../../../src/modules/legal/${nome}.service`));
    assert.deepEqual(exportadas.filter((n) => /^(delete|remove|destroy|purge)/i.test(n)), [], `${nome}.service exporta exclusão física`);
  }

  // 4) a metade do descarte (M9-D912): o contrato do escopo jurídico sob legal hold aparece em blocked_by_hold, o apply o pula e nada o arquiva; assinatura, vistoria e prova crítica
  //    nem são alvo da retenção (só poderiam sair por rota de exclusão, que não existe)
  const retention = require('../../../src/features/core-governance/data-quality/retention.targets').all().filter((target) => target.table).map((target) => `${target.schema}.${target.table}`);
  for (const table of ['legal.signatures', 'legal.contract_signatures', 'legal.inspections', 'legal.evidence_packages']) assert.equal(retention.includes(table), false, `${table} é alvo de retenção`);
  const tenants = await require('../../m9d801.helpers').loadTenants();
  const proof = await require('../_helpers/m9d912Aud018').contractUnderHold(tenants.A);
  assert.deepEqual(proof, { blockedByHold: 1, heldQueued: false, freeQueued: true, heldArchived: false, freeArchived: true });
});
