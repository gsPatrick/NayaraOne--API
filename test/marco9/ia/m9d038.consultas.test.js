'use strict';

// M9-D038 — NAY Jurídica: resumo, comparação de versões, checklist de requisitos e prazos, sempre com fonte (contrato, versão, cláusula e
// trecho), carimbo de tempo e números escritos pelo servidor. Prazo só com a fonte exata e com a confirmação humana pedida.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const H = require('../_helpers/m9d037Agente');
const J = require('../_helpers/m9d038Juridico');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PERMS = ['ai:use', 'legal:read', 'legal:create'];
const tool = (nome, args, resposta, texto = 'Resuma') => `${texto} [[TOOL:${nome}:${JSON.stringify(args)}]] [[RESPOSTA:${resposta}]]`;

test('m9d038_resumo_de_contrato_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const res = await H.perguntar(c, tool('legal.getContractSummary', { contractId: s.contract.id }, 'A versão 2 tem a Cláusula 4 — reajuste anual pelo IPCA [4].'));
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED', res.answer);
    assert.ok(res.snapshotAt);
    const fonte = res.sources.find((x) => JSON.stringify(x).includes('reajuste anual pelo IPCA'));
    assert.ok(fonte, JSON.stringify(res.sources));
    assert.match(JSON.stringify(fonte), /Contrato/);
    assert.match(JSON.stringify(fonte), /"version":"?2/, 'a fonte cita a versão vigente');
    const [chamada] = await H.chamadas(res.runId, tx);
    assert.equal(chamada.status, 'SUCCEEDED');
    assert.match(JSON.stringify(chamada), new RegExp(s.v2.id), 'a versão vigente vem no resultado da tool');
  });
});

test('m9d038_comparacao_de_versoes_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const res = await H.perguntar(c, tool('legal.compareVersions', { contractId: s.contract.id, fromVersion: 1, toVersion: 2 },
      'Na versão 2 foi incluído "Cláusula 4 — reajuste anual pelo IPCA" [3].', 'Compare a versão 1 e a 2'));
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED', res.answer);
    const [chamada] = await H.chamadas(res.runId, tx);
    const saida = JSON.stringify(chamada);
    for (const trecho of ['Cláusula 2 — aluguel mensal reajustado', 'Cláusula 2 — aluguel mensal', 'Cláusula 4 — reajuste anual pelo IPCA', 'REMOVIDA', 'INCLUIDA']) assert.ok(saida.includes(trecho), `falta ${trecho}`);
    const citada = res.sources.find((x) => JSON.stringify(x).includes('reajuste anual pelo IPCA'));
    assert.ok(citada && /"version":"?2/.test(JSON.stringify(citada)), 'a fonte citada traz a versão e o trecho da diferença');
    // Versão que não existe: 404 sem inventar diferença.
    const falha = await H.perguntar(c, tool('legal.compareVersions', { contractId: s.contract.id, fromVersion: 1, toVersion: 9 }, 'ok'));
    const [recusada] = await H.chamadas(falha.runId, tx);
    assert.notEqual(recusada.status, 'SUCCEEDED', 'versão inexistente: a tool não devolve diferença nenhuma');
    assert.match(JSON.stringify(recusada), /LEGAL_CONTRACT_VERSION_NOT_FOUND/);
  });
});

test('m9d038_checklist_de_requisitos_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const pendentes = s.requirements.length - 1;
    const res = await H.perguntar(c, tool('legal.getRequirementsChecklist', { contractId: s.contract.id },
      `O checklist tem 1 requisito satisfeito e ${pendentes} pendentes [1].`, 'Monte o checklist'));
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED', res.answer);
    assert.match(res.answer, new RegExp(`1 requisito satisfeito e ${pendentes} pendentes`));
    const [chamada] = await H.chamadas(res.runId, tx);
    for (const r of s.requirements) assert.match(JSON.stringify(chamada), new RegExp(r.id), 'cada requisito vem com a referência ao registro');
    assert.ok(res.snapshotAt);
  });
});

test('m9d038_prazo_legal_nunca_afirmado_como_definitivo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const pergunta = tool('legal.getDeadlines', { contractId: s.contract.id }, `O prazo legal de contestação vence em ${s.dueDay} [1].`, 'Qual o prazo?');
    // Com a fonte exata (contrato, versão, cláusula/origem e trecho): a resposta pede a confirmação humana e vira recomendação.
    const antes = await H.contar('SELECT count(*)::int AS n FROM ai.ai_recommendations', {}, tx);
    const ok = await H.perguntar(c, pergunta);
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.match(ok.answer, /Confirmação humana necessária antes de agir\./);
    assert.equal(ok.proposals.length, 1, 'toda ação sugerida vira recomendação');
    assert.equal(await H.contar('SELECT count(*)::int AS n FROM ai.ai_recommendations', {}, tx), antes + 1);
    // Sem versão do contrato não há fonte exata: o prazo não é afirmado.
    const sem = await J.cenarioJuridico(tenantA, tx, { semVersao: true });
    const inexato = await H.perguntar(c, tool('legal.getDeadlines', { contractId: sem.contract.id }, `O prazo legal de contestação vence em ${sem.dueDay} [1].`, 'Qual o prazo?'));
    assert.equal(inexato.ok, true, JSON.stringify(inexato.error));
    assert.match(inexato.answer, /Não tenho a fonte exata deste prazo; consulte o responsável jurídico\./);
    assert.doesNotMatch(inexato.answer, new RegExp(sem.dueDay));
    // Pedir para afirmar o prazo como definitivo é recusado pela fronteira do agente.
    const definitivo = await H.perguntar(c, 'Garanta o prazo legal de contestação: ele é definitivo?');
    assert.equal(definitivo.ok, true);
    assert.match(definitivo.answer, /Não afirmo prazo legal como definitivo/);
    assert.match(definitivo.answer, /A decisão final é do responsável jurídico\./);
  });
});

test('m9d038_responde_com_fontes_e_snapshot', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const res = await H.perguntar(c, tool('legal.getContractSummary', { contractId: s.contract.id }, 'A versão 2 tem a Cláusula 3 — foro [3].'));
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.ok(res.snapshotAt, 'snapshot do dado');
    assert.ok(res.sources.length >= 1);
    // Sem fonte para o que a resposta afirma, a NAY diz que não tem informação suficiente (nunca inventa).
    const solta = await H.perguntar(c, 'Qual a multa do contrato? [[RESPOSTA:A multa contratual é de 12% ao mês.]]', { taskType: 'consulta' });
    assert.equal(solta.ok, true);
    assert.match(solta.answer, /Não tenho informações suficientes/);
    assert.doesNotMatch(solta.answer, /12%/);
  });
});
