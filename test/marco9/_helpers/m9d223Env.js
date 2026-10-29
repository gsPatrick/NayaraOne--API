'use strict';

// Apoio dos testes do health check ativo (M9-D223): adapter com teste de saúde programável e leitura da linha de saúde/erros.
const m = require('./m9d217Env');
const { mensagemProgramavel } = require('./m9d214Scripted');
const { instalar } = require('./m9d214Env');

/** Classe de mensageria cujo teste de saúde segue o roteiro: { ok, latencyMs } | { lanca: true } | { malformado: true } | { espera: ms }. */
function mensagemComSaude() {
  const Msg = mensagemProgramavel({ idempotente: true });
  Msg.H = { chamadas: 0, passo: { ok: true, latencyMs: 12 } };
  Msg.prototype.healthCheck = async function saude() {
    Msg.H.chamadas += 1;
    const p = Msg.H.passo;
    if (p.espera) await new Promise((r) => setTimeout(r, p.espera));
    if (p.lanca) throw new Error('token sk-live-abcdef0123456789abcdef quebrou');
    if (p.malformado) return { ok: 'sim' };
    return { ok: p.ok, latencyMs: p.latencyMs ?? 5, detail: p.ok ? 'tudo certo' : 'fornecedor fora' };
  };
  return Msg;
}

const errosDe = (tenant, id, code) => m.comTenant(tenant, async (t) => (await m.sequelize.query(
  'SELECT * FROM integration.integration_errors WHERE connection_id = :id AND error_code = :code ORDER BY created_at', { replacements: { id, code }, transaction: t },
))[0]);

/** Tenant do seed de CI (A ou B): é o dos usuários que fazem login nos testes HTTP. */
async function tenantCI(letra) {
  const { Group, Company } = require('../../../src/models');
  const { tenant } = await m.carregarTenants();
  const grupo = await Group.findOne({ where: { name: `CI — Grupo Fictício ${letra}` } });
  const empresa = await m.sequelize.transaction(async (t) => {
    await m.sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: grupo.id }, transaction: t });
    return Company.findOne({ where: { groupId: grupo.id, name: `CI — Empresa Fictícia ${letra}` }, transaction: t });
  });
  return { groupId: grupo.id, companyId: empresa.id, userId: tenant.userId };
}

module.exports = { ...m, mensagemComSaude, instalar, errosDe, tenantCI };
