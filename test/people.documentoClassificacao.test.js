'use strict';

// CAD-05 (livro §5; DI-M3PE-6): "Upload -> antivírus -> hash -> classificação -> OCR/IA -> dados sugeridos".
// - existe a etapa de classificação (declaração, nome do arquivo e conteúdo; divergência e "não classificado" viram pendência);
// - o limiar de confiança e os campos críticos por tipo são parâmetros da empresa;
// - os motores de laboratório não valem fora do teste sem o administrador ligar: sem antivírus real o envio é recusado (503) e sem
//   leitura real o documento entra sem dado lido e com pendência (nada simulado).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const { ingestPersonDocument } = require('../src/features/people/documentIngestion.service');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { classifyBeforeReading, confirmWithText } = require('../src/features/people/personDocumentClassifier');
const { defaultDocumentParams } = require('../src/features/people/personDocument.settings');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const mock = (fields, confidence, text = '') => Buffer.from(JSON.stringify({ __mockOcr: { fields, confidence, text } }), 'utf8').toString('base64');
const pessoa = (t) => personService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Documento ${uniqueSuffix()} Silva` }, tenant.userId, t);
const enviar = (t, personId, extra) => ingestPersonDocument({ groupId: tenant.groupId, companyId: tenant.companyId, personId, mimeType: 'application/pdf', fileName: 'arquivo.pdf', ...extra }, tenant.userId, t);
const regras = defaultDocumentParams().classificacao;

async function comAmbiente(vars, fn) {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { return await fn(); } finally { Object.entries(antes).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}

test('classificação: declaração, nome do arquivo e conteúdo; CIN não vira RG; divergência e "não classificado" geram pendência', () => {
  assert.deepEqual(classifyBeforeReading({ documentType: 'rg', fileName: 'x.pdf' }, regras), { declarado: 'RG', porNome: null, tipo: 'RG', metodo: 'DECLARADO' });
  const porNome = classifyBeforeReading({ fileName: 'Carteira_Nacional_de_Habilitacao-joao.pdf' }, regras);
  assert.equal(porNome.tipo, 'CNH');
  assert.equal(porNome.metodo, 'NOME_DO_ARQUIVO');
  const semNada = classifyBeforeReading({ fileName: 'scan001.pdf' }, regras);
  assert.equal(semNada.tipo, 'OTHER');
  const porTexto = confirmWithText(semNada, 'REPÚBLICA FEDERATIVA DO BRASIL\nCARTEIRA DE IDENTIDADE NACIONAL\nNome: Ana', regras);
  assert.equal(porTexto.tipo, 'CIN');
  assert.equal(porTexto.metodo, 'CONTEUDO');
  assert.equal(porTexto.pendencia, null);
  const divergente = confirmWithText(classifyBeforeReading({ documentType: 'RG' }, regras), 'Carteira Nacional de Habilitação - DETRAN', regras);
  assert.equal(divergente.tipo, 'RG');
  assert.match(divergente.pendencia, /Tipo informado \(RG\) diverge do identificado no conteúdo \(CNH\)/);
  assert.match(confirmWithText(semNada, 'texto qualquer sem pista', regras).pendencia, /não classificado/);
  assert.throws(() => classifyBeforeReading({ documentType: 'r g!' }, regras), (err) => err.code === 'DOCUMENT_INGESTION_VALIDATION');
});

test('CAD-05 envio sem tipo: o conteúdo classifica, o tipo decidido vale para os campos críticos e a classificação fica gravada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await pessoa(t);
    const { personDocument, pendingTask } = await enviar(t, p.id, { contentBase64: mock({ name: p.legalName, issuedAt: '2020-01-01', expiresAt: '2030-01-01' }, 0.95, 'CARTEIRA NACIONAL DE HABILITAÇÃO') });
    assert.equal(personDocument.documentType, 'CNH');
    assert.equal(personDocument.extractedDataJson.classification.metodo, 'CONTEUDO');
    assert.deepEqual(personDocument.extractedDataJson.classification.expressoes, ['carteira nacional de habilitacao']);
    assert.deepEqual(personDocument.extractedDataJson.engines, { antivirus: 'LABORATORIO', leitura: 'LABORATORIO' });
    assert.equal(pendingTask, null);
    const divergente = await enviar(t, p.id, { documentType: 'HOLERITE', contentBase64: mock({ name: p.legalName, income: 10 }, 0.95, 'Extrato de conta corrente - saldo anterior') });
    assert.equal(divergente.personDocument.documentType, 'HOLERITE');
    assert.match(divergente.pendingTask.description, /diverge do identificado no conteúdo \(BANK_STATEMENT\)/);
  });
});

test('CAD-05 limiar de confiança e campos críticos são parâmetros da empresa (people.documentos.*), com validação na escrita', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await pessoa(t);
    const holerite = (conf) => enviar(t, p.id, { documentType: 'HOLERITE', contentBase64: mock({ name: p.legalName, income: 3500 }, conf) });
    assert.equal((await holerite(0.8)).pendingTask, null, 'com o padrão 0,7, confiança 0,8 não abre pendência');
    await upsertSetting('people.documentos.confianca_minima', 0.9, tenant, tenant.userId, t);
    assert.match((await holerite(0.8)).pendingTask.description, /abaixo do mínimo exigido \(0.9\)/);
    const cnh = () => enviar(t, p.id, { documentType: 'CNH', contentBase64: mock({ name: p.legalName }, 0.95) });
    assert.match((await cnh()).pendingTask.description, /issuedAt, expiresAt/);
    await upsertSetting('people.documentos.campos_criticos', 'CNH=name; HOLERITE=name+income', tenant, tenant.userId, t);
    assert.equal((await cnh()).pendingTask, null);
    for (const [key, valor] of [['people.documentos.campos_criticos', 'CNH=nome'], ['people.documentos.classificacao', 'CNH='], ['people.documentos.confianca_minima', 1.5]]) {
      await assert.rejects(() => upsertSetting(key, valor, tenant, tenant.userId, t), (err) => err.code === 'SETTING_INVALID_VALUE');
    }
  });
});

test('CAD-05 fora do teste, sem antivírus real e sem o parâmetro: envio recusado (503) antes de gravar qualquer arquivo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await pessoa(t);
    const [{ n: antes }] = await sequelize.query('SELECT count(*)::int AS n FROM people.files', { transaction: t, type: sequelize.QueryTypes.SELECT });
    await comAmbiente({ NODE_ENV: 'production', ANTIVIRUS_PROVIDER: undefined, OCR_PROVIDER: undefined }, () =>
      assert.rejects(() => enviar(t, p.id, { documentType: 'RG', contentBase64: mock({ name: p.legalName }, 0.99) }), (err) => {
        assert.equal(err.code, 'DOCUMENT_ANTIVIRUS_UNAVAILABLE');
        assert.equal(err.statusCode, 503);
        return true;
      }));
    const [{ n: depois }] = await sequelize.query('SELECT count(*)::int AS n FROM people.files', { transaction: t, type: sequelize.QueryTypes.SELECT });
    assert.equal(depois, antes);
  });
});

test('CAD-05 fora do teste com antivírus real e sem leitura real: o JSON de simulação NÃO vira dado; o documento fica sem campo e com pendência', async () => {
  if (!process.env.CLAMAV_HOST) return; // o antivírus real é o ClamAV da máquina (CLAMAV_HOST/CLAMAV_PORT), como no CI
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await pessoa(t);
    const r = await comAmbiente({ NODE_ENV: 'production', ANTIVIRUS_PROVIDER: 'clamav', OCR_PROVIDER: undefined }, () =>
      enviar(t, p.id, { documentType: 'RG', contentBase64: mock({ name: 'Nome Inventado' }, 0.99) }));
    assert.deepEqual(r.personDocument.extractedDataJson.fields, {});
    assert.deepEqual(r.personDocument.extractedDataJson.engines, { antivirus: 'CLAMAV', leitura: 'INDISPONIVEL' });
    assert.match(r.pendingTask.description, /Leitura automática indisponível/);
  });
});

test('CAD-05 o administrador pode ligar os motores de laboratório fora do teste (decisão consciente, parâmetro auditado)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await pessoa(t);
    await upsertSetting('people.documentos.motores_laboratorio', true, tenant, tenant.userId, t);
    const r = await comAmbiente({ NODE_ENV: 'production', ANTIVIRUS_PROVIDER: undefined, OCR_PROVIDER: undefined }, () =>
      enviar(t, p.id, { documentType: 'RG', contentBase64: mock({ name: p.legalName }, 0.95) }));
    assert.deepEqual(r.personDocument.extractedDataJson.engines, { antivirus: 'LABORATORIO', leitura: 'LABORATORIO' });
    const [audit] = await sequelize.query("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_type = 'TenantSetting' AND (after_json::text LIKE '%motores_laboratorio%' OR reason LIKE '%motores_laboratorio%')",
      { transaction: t, type: sequelize.QueryTypes.SELECT });
    assert.ok(audit.n >= 1, 'a alteração do parâmetro tem de ficar na auditoria');
  });
});
