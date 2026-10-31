'use strict';

// M9-D441 carga (c): canSend sobre tabelas grandes de crm.messages, suppression_list, consentimentos, contatos e execuções de automação usa índice. O volume é criado pelo superusuário do banco
// descartável (20 mil pessoas, 300 mil mensagens, 100 mil supressões, 50 mil execuções), as consultas que o canSend de fato faz são capturadas e cada uma é explicada com o role de runtime
// (RLS aplicada): nenhuma pode varrer sequencialmente uma tabela grande. Só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withTenantTransaction } = require('../../../testHelpers');
const env = require('../../_helpers/mktPolicyEnv');
const carga = require('../../_helpers/mktCarga');
const volume = require('../../_helpers/mktCargaVolume');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const { canSend } = require('../../../../src/features/marketing/suppression');

const N = { pessoas: 20000, mensagens: 300000, supressoes: 100000, runs: 50000 };
const GRANDES = ['messages', 'suppression_list', 'communication_consents', 'person_contacts', 'automation_runs', 'persons'];
const ATE = new Date('2026-11-09T17:00:00Z'); // meio-dia em São Paulo: fora do horário de silêncio, todas as etapas rodam
let tenant; let flowId; let amostra;

before(async () => {
  if (!carga.DISPOSABLE) return;
  ({ tenantA: tenant } = await prepararTenants());
  const flow = await withTenantTransaction(tenant, (t) => env.makeFlowVersion(t, tenant));
  flowId = flow.flowId;
  await carga.withAdmin(async (admin) => {
    ({ amostra } = await volume.criarVolume(admin, tenant, flow.versionId, N));
    await volume.reservar(admin, tenant, flow.versionId, amostra, new Date(ATE.getTime() - 3600000)); // ação reservada e ainda sem mensagem: o canSend a confere
    await admin.query('ANALYZE marketing.automation_runs');
  });
});
after(async () => {
  if (carga.DISPOSABLE && tenant) await carga.withAdmin((admin) => volume.apagarVolume(admin, tenant, flowId));
  await sequelize.close();
});

/** O plano em texto compacto (um nó por linha: tipo, tabela, índice e filtro), para a mensagem de falha mostrar o que o planejador escolheu. */
const resumo = (node, nivel = 0) => [`${'  '.repeat(nivel)}${node['Node Type']}${node['Relation Name'] ? ` ${node['Relation Name']}` : ''}${node['Index Name'] ? ` [${node['Index Name']}]` : ''} rows=${node['Plan Rows']}`, ...(node.Plans || []).flatMap((p) => resumo(p, nivel + 1))];

/** Nós "Seq Scan" do plano (com a tabela). */
const varreduras = (node, out = []) => {
  if (node['Node Type'] === 'Seq Scan') out.push(node['Relation Name']);
  (node.Plans || []).forEach((p) => varreduras(p, out));
  return out;
};

test('canSend_usa_indice_em_tabelas_grandes', { skip: carga.SKIP }, async (tctx) => {
  const sqls = new Set();
  const antes = sequelize.options.logging;
  await withTenantTransaction(tenant, async (t) => {
    sequelize.options.logging = (sql) => { sqls.add(String(sql).replace(/^Executing \([^)]*\):\s*/, '')); };
    try {
      for (const personId of amostra) {
        const out = await canSend(personId, 'WHATSAPP', 'MARKETING', ATE, { tenant, transaction: t });
        assert.ok(['FREQUENCY_CAP', 'CHANNEL_POLICY', null, undefined].includes(out.reason) || out.allowed, `canSend: ${JSON.stringify(out)}`);
      }
    } finally { sequelize.options.logging = antes; }
    const selects = [...sqls].filter((s) => /^\s*SELECT/i.test(s) && /\bFROM\b/i.test(s) && GRANDES.some((tab) => new RegExp(`\\b${tab}\\b`).test(s)));
    const tocadas = new Set();
    for (const sql of selects) for (const tab of GRANDES) if (new RegExp(`\\b${tab}\\b`).test(sql)) tocadas.add(tab);
    for (const tab of ['messages', 'suppression_list', 'communication_consents', 'person_contacts']) assert.ok(tocadas.has(tab), `o canSend consultou ${tab}`);
    const problemas = [];
    for (const sql of selects) {
      const [{ 'QUERY PLAN': plano }] = await sequelize.query(`EXPLAIN (FORMAT JSON) ${sql.replace(/;\s*$/, '')}`, { transaction: t, type: 'SELECT' });
      const seq = varreduras(plano[0].Plan).filter((tab) => GRANDES.includes(tab));
      if (seq.length) problemas.push(`${seq.join(',')} <- ${sql.replace(/\s+/g, ' ').slice(0, 120)}\n${resumo(plano[0].Plan).join('\n')}`);
    }
    assert.deepEqual(problemas, [], `varredura sequencial em tabela grande:\n${problemas.join('\n')}`);
    tctx.diagnostic(`${selects.length} consultas do canSend explicadas sobre ${N.pessoas} pessoas, ${N.mensagens} mensagens, ${N.supressoes} supressões e ${N.runs} execuções: nenhuma varredura sequencial em ${[...tocadas].join(', ')}`);
  });
});
