'use strict';

/**
 * Leitura pela APLICAÇÃO depois do restore de Obras (Marco 6, Caderno §13 DoD "restore verdes"): sobe a API real (app.js) no
 * processo da verificação, apontando para o banco RESTAURADO com a role de runtime (NOSUPERUSER/NOBYPASSRLS), e confere pelo
 * HTTP, com o JWT e o middleware de tenant reais:
 *   - a obra, a Saúde da obra (os campos de dinheiro do read model do Guia §7), as medições da etapa e o diário respondem 200 e com
 *     os MESMOS valores que o serviço calculou na origem antes do backup (fixtures.saudeNoBackup);
 *   - outra empresa (mesmo grupo) recebe 404 e quem não tem construction:read recebe 403.
 * Os tokens são assinados com a chave temporária do drill (como os testes HTTP de Obras e o drill jurídico); nada de MFA.
 * O processo chamador precisa ter DATABASE_URL = runtime do destino e PORT = porta HTTP livre ANTES de chamar.
 */
const crypto = require('crypto');

const CAMPOS_DE_DINHEIRO = ['baselineBudget', 'approvedChanges', 'committedCost', 'actualFinancialCost', 'consumedInventoryCost', 'forecastToComplete',
  'projectedTotalCost', 'projectedMargin', 'marginPct', 'ruleVersionId'];

function retratoDaSaude(saude) {
  const r = {};
  for (const c of CAMPOS_DE_DINHEIRO) r[c] = saude[c] === undefined ? null : saude[c];
  r.payablePendingTotal = saude.kpis ? saude.kpis.payablePendingTotal : null;
  const porStatus = (saude.kpis && saude.kpis.measurementsByStatus) || {};
  r.measurementsByStatus = Object.fromEntries(Object.keys(porStatus).sort().map((k) => [k, porStatus[k]]));
  return r;
}

async function conferirLeituraPelaApi(fx, check) {
  if (!process.env.PORT || !process.env.DATABASE_URL) throw new Error('verifyConstructionAppRead: defina PORT e DATABASE_URL (runtime do destino) antes');
  require('../../app');
  const { signAccessToken } = require('../../src/utils/jwt');
  const base = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  const token = (companyId, permissions) => signAccessToken({ sub: fx.tenant.userId, group_id: fx.tenant.groupId, company_id: companyId, roles: ['drill'], permissions });
  const leitor = token(fx.tenant.companyId, ['construction:read']);
  const get = async (rota, tk = leitor) => {
    const r = await fetch(`${base}${rota}`, { headers: { Authorization: `Bearer ${tk}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`)).status === 200) break; } catch (_) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const obra = await get(`/construction/projects/${fx.projectId}`);
  check('API sobre o banco restaurado: GET /construction/projects/:id -> 200 com o estado de antes do backup', obra.status === 200 && obra.body.data && obra.body.data.status === fx.statusNoBackup,
    `HTTP ${obra.status}, status ${obra.body.data && obra.body.data.status}`);
  const saude = await get(`/construction/projects/${fx.projectId}/health`);
  const depois = saude.status === 200 ? retratoDaSaude(saude.body.data) : null;
  check('API sobre o banco restaurado: Saúde da obra (read model de custo do Guia §7) com os MESMOS valores calculados na origem antes do backup',
    saude.status === 200 && JSON.stringify(depois) === JSON.stringify(fx.saudeNoBackup), { http: saude.status, origem: fx.saudeNoBackup, destino: depois });
  const medicoes = await get(`/construction/stages/${fx.stageId}/measurements`);
  const lista = Array.isArray(medicoes.body.data) ? medicoes.body.data : (medicoes.body.data && medicoes.body.data.items) || [];
  const medicao = lista.find((m) => m.id === fx.measurementId);
  check('API sobre o banco restaurado: medição PAYABLE com o mesmo valor e a mesma conta a pagar', medicoes.status === 200 && medicao && medicao.status === 'PAYABLE'
    && Number(medicao.totalAmount) === fx.measurementTotal && medicao.payableFinancialEntryId === fx.payableId, { http: medicoes.status, medicao: medicao && { status: medicao.status, total: medicao.totalAmount } });
  const diario = await get(`/construction/projects/${fx.projectId}/daily-reports`);
  const rdos = (diario.body.data || []).map((r) => r.id);
  check('API sobre o banco restaurado: o diário mostra a correção (a original fica no histórico)', diario.status === 200 && rdos.includes(fx.rdoRevisionId) && !rdos.includes(fx.rdoOriginalId), `HTTP ${diario.status}, ${rdos.length} RDO(s) visível(is)`);
  const historico = await get(`/construction/daily-reports/${fx.rdoRevisionId}/history`);
  check('API sobre o banco restaurado: o histórico do RDO traz o original preservado', historico.status === 200 && JSON.stringify(historico.body.data || '').includes(fx.rdoOriginalId), `HTTP ${historico.status}`);
  const outra = await get(`/construction/projects/${fx.projectId}`, token(crypto.randomUUID(), ['construction:read']));
  check('API sobre o banco restaurado: outra empresa do grupo não vê a obra (404)', outra.status === 404, `HTTP ${outra.status}`);
  const semPermissao = await get(`/construction/projects/${fx.projectId}`, token(fx.tenant.companyId, ['finance:read']));
  check('API sobre o banco restaurado: sem construction:read -> 403', semPermissao.status === 403, `HTTP ${semPermissao.status}`);
}

module.exports = { conferirLeituraPelaApi, retratoDaSaude };
