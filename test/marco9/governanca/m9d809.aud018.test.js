'use strict';

// M9-D809 — AUD-018 (JUR-011): prova jurídica não é apagada. Nenhuma rota nem serviço de exclusão física de contrato, assinatura, vistoria, dossiê, processo, notificação, aditivo ou
// entrega de chaves, e o inventário de ações destrutivas da M9-D852 não lista exclusão física deles. Sem banco além da carga das rotas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'segredo-de-teste-m9d809';
const skip = DISPOSABLE ? false : SKIP_DISPOSABLE;

// Recursos do escopo jurídico (JUR-011): contratos, assinaturas, vistorias e provas críticas (dossiê, processo, notificação, aditivo, entrega de chaves, prazo, versão).
const ESCOPO = /\/legal\/(contracts|signatures|inspections|evidence-packages|cases|notices|amendments|key-deliveries|deadlines|contract-versions)\b/;
const SERVICOS = ['contracts', 'contractVersions', 'contractAmendments', 'signatures', 'inspections', 'evidencePackages', 'legalCases', 'legalDeadlines', 'notices', 'keyDeliveries'];

test('m9d809 AUD-018 retention apply pula registro do escopo jurídico e nenhuma rota de exclusão física dele existe no inventário', { skip }, () => {
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
    const exportadas = Object.keys(require(`../../../src/features/legal/${nome}.service`));
    assert.deepEqual(exportadas.filter((n) => /^(delete|remove|destroy|purge)/i.test(n)), [], `${nome}.service exporta exclusão física`);
  }
});
