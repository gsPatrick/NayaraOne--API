'use strict';

// M9-D040 — cadastro da NAY Documental: propósito, allowlist, escopos e limites; golden e adversarial verdes antes de habilitar; resposta com
// fontes e snapshot; OCR da nota de estoque preservado; parâmetros lidos de verdade; padrão do sistema aplicado pelo seed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, QueryTypes } = require('sequelize');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas, ctxDe } = require('../../helpers/aiAgents');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const agents = require('../../../src/features/ai/agents');
const { computeConfigHash } = require('../../../src/features/ai/agents/agentConfigHash');
const { provisionAgentVersion, applySystemDefinition } = require('../../../src/features/ai/agents/kit');
const N = require('../../../src/features/ai/agents/nay_documental');
const { DOCUMENTAL_SETTING_DEFAULTS: PADROES, DOCUMENTAL_SETTINGS_SCHEMA } = N;
const receiptOcr = require('../../../src/features/inventory/receiptOcr.service');
const { MOCK_MARKER } = require('../../../src/features/people/adapters/OcrAdapter');
const H = require('../_helpers/iaDocumental');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);

test('m9d040_agente_cadastrado_com_proposito_tools_escopos_e_limites', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await carregarPessoas();
    const v = await provisionAgentVersion(ctxDe(tenantA), N.DEFINITION, tx);
    assert.deepEqual([v.code, v.version, v.status, v.enabled, v.criticality], ['NAY_DOCUMENTAL', 1, 'DRAFT', false, 'NON_CRITICAL']);
    assert.match(v.purpose, /ler documentos \(OCR\), sugerir classificação, extrair campos e checar consistência, devolvendo resultado para revisão humana/i);
    assert.deepEqual([...v.dataScopes].sort(), ['documents.field_models', 'files.company_files']);
    assert.equal(v.limits.max_tool_calls_por_run, 5);
    assert.deepEqual(v.tools.map((t) => t.toolName).sort(), ['documents.checkConsistency', 'documents.classifySuggest', 'documents.extractFields', 'documents.transcribe', 'knowledge.search']);
    assert.ok(v.tools.every((t) => t.permissionCode === 'ai:use' && t.riskLevel === 'LOW' && !t.requiresHumanApproval));
    for (const termo of [/Nunca grave a classificação nem os campos no cadastro/, /nunca aprove documento/, /nunca leia arquivo não verificado pelo antivírus ou de outra empresa/, /nunca guarde o texto completo de um documento fora do índice autorizado/, /conteúdo não confiável/]) assert.match(v.systemPolicy, termo);
    assert.equal(v.configHash, computeConfigHash({ code: v.code, purpose: v.purpose, systemPolicy: v.systemPolicy, modelPolicy: v.modelPolicy, dataScopes: v.dataScopes, limits: v.limits, criticality: v.criticality, tools: v.tools }));
    assert.equal((await provisionAgentVersion(ctxDe(tenantA), N.DEFINITION, tx)).replay, true);
    assert.equal(agents.listVersions ? (await agents.listVersions(ctxDe(tenantA), 'NAY_DOCUMENTAL', tx)).filter((x) => x.companyId).length : 1, 1);
  });
});

test('m9d040_golden_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const ev = c.evaluation;
    assert.equal(ev.status, 'PASSED', 'golden e adversarial verdes');
    assert.equal(ev.suite, 'ALL');
    const categorias = new Set(ev.items.map((i) => i.category));
    for (const cat of ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'INJECTION', 'COST', 'LATENCY']) assert.ok(categorias.has(cat), `categoria ${cat} avaliada`);
    assert.ok(ev.items.every((i) => i.passed));
    assert.ok(ev.items.some((i) => i.caseId.startsWith('golden:doc_')), 'os casos do dataset do agente entraram');
    const v = await agents.getVersion(c.ctx, 'NAY_DOCUMENTAL', c.version, tx);
    assert.deepEqual([v.status, v.enabled], ['ACTIVE', true]);
    // agente de alto impacto: versão sem avaliação homologada não liga
    const nova = await agents.createVersion(H.como(tenantA, c.pessoas.criador), 'NAY_DOCUMENTAL', { systemPolicy: `${N.DEFINITION.systemPolicy} Revisada.` }, tx);
    await assert.rejects(agents.homologate(H.como(tenantA, c.pessoas.homologador), 'NAY_DOCUMENTAL', nova.version, {}, tx), (e) => ['AI_REGRESSION_REQUIRED', 'AI_AGENT_EVALUATION_REQUIRED'].includes(e.code));
    await assert.rejects(agents.activate(H.como(tenantA, c.pessoas.ativador), 'NAY_DOCUMENTAL', nova.version, tx), (e) => e.statusCode === 409);
  });
});

test('m9d040_responde_com_fontes_e_snapshot', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const nf = await H.arquivoOcr(tenantA, tx, { fields: { valor_total: 1250 }, positions: { valor_total: { page: 1 } } });
    const res = await H.rodar(c, `Qual o valor total da nota? ${H.chamar('documents.extractFields', { fileId: nf.id, documentType: 'INVOICE_NF' })} [[RESPOSTA:O valor total da nota é 1250.00, na página 1 [1].]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.ok(res.sources.length >= 1);
    assert.ok(res.snapshotAt, 'snapshot da consulta');
    assert.match(res.answer, /1250\.00/);
    const run = await H.lerRun(res.runId, tx);
    assert.deepEqual([run.agent_name, run.status], ['NAY_DOCUMENTAL', 'COMPLETED']);
    assert.ok(run.snapshot_at);
    const [fonte] = await H.q('SELECT source_type, source_ref FROM ai.ai_sources WHERE ai_run_id = :r', { r: res.runId }, tx);
    assert.deepEqual([fonte.source_type, fonte.source_ref], ['TOOL_RESULT', 'documents.extractFields']);
    // sem fonte (nenhuma ferramenta): insuficiência, nunca invenção
    const sem = await H.rodar(c, 'Qual o valor total da nota? [[RESPOSTA:O valor total é 9999.00.]]', { idempotencyKey: 'sem-fonte' });
    assert.equal(sem.groundingStatus, 'INSUFFICIENT_SOURCES');
    assert.doesNotMatch(sem.answer, /9999/);
  });
});

test('m9d040_receiptOcr_continua_funcionando', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const conteudo = JSON.stringify({ [MOCK_MARKER]: { fields: { invoiceNumber: '000321', supplierName: 'Casa Teste LTDA', totalAmount: '100,00', items: [{ description: 'Item sem cadastro', quantity: 2, unitPrice: 50 }] }, confidence: 0.93 } });
    const out = await receiptOcr.suggestReceiptFromInvoice({ groupId: tenantA.groupId, companyId: tenantA.companyId, fileName: 'nf.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(conteudo).toString('base64') }, tenantA.userId, tx);
    assert.equal(out.status, 'SUGGESTED');
    assert.equal(out.requiresHumanReview, true);
    assert.deepEqual(out.decisionsMade, []);
    assert.equal(out.suggestion.items.length, 1);
    // o mesmo arquivo pode ser lido pela NAY Documental sem alterar o fluxo do estoque
    const c = await H.cenario(tenantA, tx);
    const lido = await H.rodar(c, `Extraia os campos da nota ${H.chamar('documents.extractFields', { fileId: out.invoiceFileId, documentType: 'INVOICE_NF' })} [[RESPOSTA:Campos lidos da nota [1].]]`);
    assert.equal(lido.ok, true, JSON.stringify(lido.error));
    assert.equal((await H.chamadas(lido.runId, tx))[0].status, 'SUCCEEDED');
  });
});

test('m9d040_parametros_declarados_sao_todos_lidos', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const lerFonte = (res, titulo) => JSON.parse(res.sources.find((s) => s.title === titulo).excerpt.replace(/\.\.\.$/, ''));
    // tipos_documento: o vocabulário da empresa manda na classificação
    const pdf = await H.arquivoPdf(tenantA, tx, { linhas: ['Termo de vistoria predial do condominio'] });
    const antes = await H.rodar(c, `Classifique ${H.chamar('documents.classifySuggest', { fileId: pdf.id })} [[RESPOSTA:Tipo sugerido [1].]]`);
    assert.equal(lerFonte(antes, 'documents.classifySuggest').suggestedType, 'OTHER');
    await upsertSetting('ia.documental.tipos_documento', `${PADROES['ia.documental.tipos_documento']};LAUDO_VISTORIA=termo de vistoria,vistoria predial`, c.ctx, c.ctx.userId, tx);
    const depois = await H.rodar(c, `Classifique ${H.chamar('documents.classifySuggest', { fileId: pdf.id })} [[RESPOSTA:Tipo sugerido [1].]]`, { idempotencyKey: 'tipos' });
    assert.equal(lerFonte(depois, 'documents.classifySuggest').suggestedType, 'LAUDO_VISTORIA');
    // campos_obrigatorios: a checagem exige o que a empresa definiu
    const doc = await H.arquivoOcr(tenantA, tx, { fields: { name: 'Ana' } });
    const semExigencia = await H.rodar(c, `Cheque ${H.chamar('documents.checkConsistency', { fileId: doc.id, documentType: 'LAUDO_VISTORIA' })} [[RESPOSTA:Checado [1].]]`, { idempotencyKey: 'c1' });
    assert.equal(lerFonte(semExigencia, 'documents.checkConsistency').findings.filter((f) => f.code === 'MISSING_FIELD').length, 0);
    await upsertSetting('ia.documental.campos_obrigatorios', `${PADROES['ia.documental.campos_obrigatorios']};LAUDO_VISTORIA=responsavel_tecnico`, c.ctx, c.ctx.userId, tx);
    const comExigencia = await H.rodar(c, `Cheque ${H.chamar('documents.checkConsistency', { fileId: doc.id, documentType: 'LAUDO_VISTORIA' })} [[RESPOSTA:Checado [1].]]`, { idempotencyKey: 'c2' });
    assert.deepEqual(lerFonte(comExigencia, 'documents.checkConsistency').findings.filter((f) => f.code === 'MISSING_FIELD').map((f) => f.field), ['responsavel_tecnico']);
    // listas de termos da fronteira: a empresa acrescenta o termo e o pedido entra no escopo; tira o termo e a proibição deixa de valer
    assert.equal((await H.rodar(c, 'Mostre o laudo pericial', { idempotencyKey: 'f1' })).answer, 'Isso foge do que este assistente pode fazer.');
    await upsertSetting('ia.documental.termos_escopo', `${PADROES['ia.documental.termos_escopo']},laudo`, c.ctx, c.ctx.userId, tx);
    assert.notEqual((await H.rodar(c, 'Mostre o laudo pericial [[RESPOSTA:Sem fonte.]]', { idempotencyKey: 'f2' })).answer, 'Isso foge do que este assistente pode fazer.');
    assert.match((await H.rodar(c, 'Aprove o documento', { idempotencyKey: 'f3' })).answer, /Não aprovo nem valido documento/);
    await upsertSetting('ia.documental.proibicao.aprovar_documento', 'termo inexistente', c.ctx, c.ctx.userId, tx);
    assert.doesNotMatch((await H.rodar(c, 'Aprove o documento [[RESPOSTA:Não tenho como.]]', { idempotencyKey: 'f4' })).answer, /Não aprovo nem valido documento/);
    // todo parâmetro declarado tem padrão e esquema (confianca_minima e max_caracteres_transcricao têm testes próprios nas funções e na fronteira)
    for (const chave of Object.keys(PADROES)) assert.ok(DOCUMENTAL_SETTINGS_SCHEMA[chave], `${chave} tem esquema`);
    assert.equal(Object.keys(PADROES).length, Object.keys(DOCUMENTAL_SETTINGS_SCHEMA).length);
  });
});

test('m9d040_padrao_do_sistema_recebe_o_cadastro_pelo_seed', { skip: DISPOSABLE ? false : 'precisa do cluster descartável' }, async () => {
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  const tx = await admin.transaction();
  try {
    const query = (sql, replacements) => admin.query(sql, { replacements, transaction: tx, type: QueryTypes.SELECT });
    const out = await applySystemDefinition(query, N.DEFINITION);
    const [row] = await query("SELECT * FROM ai.agents WHERE company_id IS NULL AND code = 'NAY_DOCUMENTAL' AND version = 1");
    assert.deepEqual([row.status, row.enabled, row.purpose], ['DRAFT', false, N.DEFINITION.purpose]);
    assert.equal(row.config_hash, out.configHash);
    assert.deepEqual(row.data_scopes, N.DEFINITION.dataScopes);
    const tools = await query('SELECT tool_name FROM ai.agent_tools WHERE agent_id = :id ORDER BY tool_name', { id: row.id });
    assert.deepEqual(tools.map((t) => t.tool_name), N.DEFINITION.tools.map((t) => t.toolName).sort());
    assert.equal((await applySystemDefinition(query, N.DEFINITION)).configHash, out.configHash, 'idempotente');
  } finally {
    await tx.rollback();
    await admin.close();
  }
});
