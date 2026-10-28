'use strict';

// M9-D403 — Dados publicáveis: allowlist de campos públicos e sanitização (MKT-001, 002, 003).
// Postgres real, role de runtime (RLS FORCE), cada teste numa transação com rollback. Rodar só em banco descartável:
// node scripts/withDisposableDb.js --port <porta> -- ... (o .env aponta para a homologação remota).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');

const { sequelize, AuditLog } = require('../src/models');
const { getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { sanitizePublicFields, assertMinimumPublicFields, REDACTION_MARKER } = require('../src/features/marketing/content/sanitize');
const { loadPublicProperty, loadPublicConstruction, loadRelationshipFacts } = require('../src/features/marketing/content/publicReadModel');
const { deliverToAdapter, recordSanitizationChecks } = require('../src/features/marketing/content/adapterGate');
const { assertContentServiceSources, findInternalSourceViolations } = require('../src/features/marketing/content/internalSourceGuard');
const settings = require('../src/features/marketing/content/publicFields.settings');
const { upsertSetting, getSetting } = require('../src/features/settings/settings.service');
const { updateProperty } = require('../src/features/properties/properties.service');

const CONTENT_DIR = path.join(__dirname, '..', 'src', 'features', 'marketing', 'content');
let tenant;
const uid = () => crypto.randomUUID();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });

async function makeProperty(t, { policy, attrs, withAddress = true, status = 'PUBLISHED' } = {}) {
  let addressId = null;
  if (withAddress) {
    [{ id: addressId }] = await q(
      t,
      `INSERT INTO real_estate.property_addresses (id, zip_code, street, number, neighborhood, city, state)
       VALUES (gen_random_uuid(), '01310-100', 'Rua das Acácias', '120', 'Jardim Europa', 'São Paulo', 'SP') RETURNING id`
    );
  }
  const [row] = await q(
    t,
    `INSERT INTO real_estate.properties (id, group_id, company_id, title, internal_code, property_type, address_id, bedrooms,
        parking_spots, area_total_m2, attributes_json, publication_status${policy ? ', public_address_policy' : ''})
     VALUES (gen_random_uuid(), :g, :c, 'Apto 42 Rua das Acácias 120', :code, 'RESIDENTIAL', :addr, 3, 2, 120, CAST(:attrs AS jsonb), :status${policy ? ', :policy' : ''})
     RETURNING id, public_id, public_address_policy, published_at`,
    { g: tenant.groupId, c: tenant.companyId, code: `QA-M9-${uid().slice(0, 8)}`, addr: addressId, attrs: JSON.stringify(attrs || {}), status, policy }
  );
  return row;
}

async function makeOffer(t, propertyId, type, price) {
  const [row] = await q(
    t,
    `INSERT INTO real_estate.property_offers (id, group_id, company_id, property_id, offer_type, asking_price, status)
     VALUES (gen_random_uuid(), :g, :c, :p, :type, :price, 'ACTIVE') RETURNING id`,
    { g: tenant.groupId, c: tenant.companyId, p: propertyId, type, price }
  );
  return row.id;
}

// 1
test('endereco_restrito_gera_payload_publico_sanitizado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await makeProperty(t); // sem política: padrão SO_BAIRRO
    await makeOffer(t, prop.id, 'SALE', 780000);
    const model = await loadPublicProperty({ propertyId: prop.id }, tenant, t);
    assert.equal(model.policy, 'SO_BAIRRO');
    assert.equal(model.payload.bairro, 'Jardim Europa');
    assert.equal(model.payload.cidade, 'São Paulo');
    assert.equal(model.payload.precoVenda, 780000);
    assert.equal('logradouro' in model.payload, false);
    assert.equal('numeroEndereco' in model.payload, false);
    const text = JSON.stringify(model.payload);
    assert.ok(!text.includes('Acácias') && !text.includes('120"') && !text.includes('01310'), 'rua, número e CEP não podem sair');
    assert.equal(model.payload.enderecoPublico, 'Jardim Europa - São Paulo/SP');
    // bruto x público lado a lado (evidência da seção 9)
    const [raw] = await q(t, 'SELECT * FROM real_estate.properties p JOIN real_estate.property_addresses a ON a.id = p.address_id WHERE p.id = :id', { id: prop.id });
    assert.equal(raw.street, 'Rua das Acácias');
    assert.equal(raw.number, '120');
  });
});

// 2
test('ocorrencia_interna_nao_entra_em_conteudo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await makeProperty(t);
    await q(
      t,
      `INSERT INTO real_estate.property_internal_occurrences (id, group_id, company_id, property_id, occurrence_type, description, visibility, created_by)
       VALUES (gen_random_uuid(), :g, :c, :p, 'RISK', 'infiltração no teto', 'INTERNAL', :u)`,
      { g: tenant.groupId, c: tenant.companyId, p: prop.id, u: tenant.userId }
    );
    const model = await loadPublicProperty({ propertyId: prop.id }, tenant, t);
    assert.ok(!JSON.stringify(model.payload).toLowerCase().includes('infiltra'));
    const dirty = sanitizePublicFields({ ...model.payload, ocorrenciaInterna: 'infiltração', occurrence_notes: 'x', observacao_interna: 'y', matricula: '123', ownerName: 'Fulano', documentos: [], Proprietário: 'Z', cpfDono: '1' }, 'SO_BAIRRO');
    for (const key of ['ocorrenciaInterna', 'occurrence_notes', 'observacao_interna', 'matricula', 'ownerName', 'documentos', 'Proprietário', 'cpfDono']) {
      assert.ok(dirty.removedKeys.includes(key), `chave ${key} deveria constar em removedKeys`);
      assert.equal(key in dirty.payload, false);
    }
  });
});

// 3
test('cpf_em_texto_livre_e_redigido', () => {
  const out = sanitizePublicFields(
    {
      texto: 'falar com João CPF 123.456.789-09',
      legenda: 'CNPJ 12.345.678/0001-95, e-mail joao@exemplo.com.br, tel (11) 99999-8888 ou 98888-7777, matrícula 123.456',
      descricao: 'Apartamento de 120 m² por R$ 780.000 e condomínio R$ 1.250,00 (ref. 2026-10-28)',
    },
    'SO_BAIRRO'
  );
  assert.equal(out.payload.texto, `falar com João CPF ${REDACTION_MARKER}`);
  assert.ok(!/12\.345|joao@|99999|98888|123\.456/.test(out.payload.legenda), out.payload.legenda);
  assert.match(out.payload.legenda, /matrícula \[REDIGIDO\]/);
  assert.equal(out.payload.descricao, 'Apartamento de 120 m² por R$ 780.000 e condomínio R$ 1.250,00 (ref. 2026-10-28)', 'números legítimos não são redigidos');
  assert.deepEqual(out.redactedPatterns, ['CNPJ', 'CPF', 'EMAIL', 'MATRICULA', 'TELEFONE']);
  const again = sanitizePublicFields(out.payload, 'SO_BAIRRO');
  assert.deepEqual(again.payload, out.payload, 'idempotente');
  assert.deepEqual(sanitizePublicFields({ texto: 'falar com João CPF 123.456.789-09' }, 'SO_BAIRRO').payload, { texto: `falar com João CPF ${REDACTION_MARKER}` }, 'determinística');
});

// 4
test('politica_padrao_e_so_bairro', async () => {
  const sample = { bairro: 'Jardim Europa', logradouro: 'Rua A', numeroEndereco: '10', cidade: 'São Paulo', uf: 'SP' };
  for (const absent of [undefined, null, '']) {
    const out = sanitizePublicFields(sample, absent);
    assert.equal(out.policy, 'SO_BAIRRO');
    assert.deepEqual(Object.keys(out.payload).sort(), ['bairro', 'cidade', 'enderecoPublico', 'uf']);
  }
  assert.equal(sanitizePublicFields(sample, 'POLITICA_INVENTADA').policy, 'OCULTO', 'valor desconhecido falha fechado');
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await makeProperty(t);
    assert.equal(prop.public_address_policy, 'SO_BAIRRO');
    await assert.rejects(
      () => q(t, "UPDATE real_estate.properties SET public_address_policy = 'QUALQUER' WHERE id = :id", { id: prop.id }),
      /properties_public_address_policy_chk|check/i
    );
  });
});

// 5
test('adapter_recebe_payload_sanitizado_duas_vezes', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const vazado = { tipo: 'RESIDENTIAL', bairro: 'Jardim Europa', logradouro: 'Rua das Acácias', numeroEndereco: '120', cidade: 'São Paulo', uf: 'SP', ocorrenciaInterna: 'infiltração', texto: 'Ligue 11 98888-7777' };
    let recebido = null;
    const adapter = { publish: async (p) => { recebido = p; return { ok: true }; } };
    const { result, removedKeys } = await deliverToAdapter(adapter, 'publish', vazado, { policy: 'SO_BAIRRO', tenant, transaction: t });
    assert.deepEqual(result, { ok: true });
    assert.notEqual(recebido, vazado);
    assert.equal('logradouro' in recebido, false);
    assert.equal('ocorrenciaInterna' in recebido, false);
    assert.equal(recebido.texto, `Ligue ${REDACTION_MARKER}`);
    assert.ok(removedKeys.includes('ocorrenciaInterna'));
    assert.equal(vazado.logradouro, 'Rua das Acácias', 'a entrada não é alterada');
    await assert.rejects(() => deliverToAdapter({}, 'publish', vazado, { policy: 'SO_BAIRRO', tenant, transaction: t }), /não implementa/);
  });
});

// 6
test('content_service_nao_le_tabela_interna', () => {
  assert.equal(assertContentServiceSources(CONTENT_DIR), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'ruim.js'), "const { Property } = require('../../../models');\nconst x = 'SELECT * FROM real_estate.properties';\n");
    fs.writeFileSync(path.join(dir, 'boa.js'), "const { sequelize } = require('../../../models');\nconst y = 'SELECT * FROM marketing.v_public_property';\n");
    const found = findInternalSourceViolations(dir);
    assert.equal(found.length, 2);
    assert.ok(found.every((v) => v.file.endsWith('ruim.js')));
    assert.throws(() => assertContentServiceSources(dir), (err) => err.code === 'MKT_INTERNAL_SOURCE_FORBIDDEN' && err.statusCode === 500
      && err.message === 'Conteúdo só pode ser gerado a partir de read models públicos.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 7
test('quatro_politicas_de_endereco_publicam_o_campo_certo', async () => {
  const esperado = {
    COMPLETO: { logradouro: 'Rua das Acácias', numeroEndereco: '120', bairro: 'Jardim Europa', enderecoPublico: 'Rua das Acácias, 120 - Jardim Europa - São Paulo/SP' },
    RUA_SEM_NUMERO: { logradouro: 'Rua das Acácias', bairro: 'Jardim Europa', enderecoPublico: 'Rua das Acácias - Jardim Europa - São Paulo/SP' },
    SO_BAIRRO: { bairro: 'Jardim Europa', enderecoPublico: 'Jardim Europa - São Paulo/SP' },
    OCULTO: { enderecoPublico: 'Endereço sob consulta' },
  };
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const [policy, fields] of Object.entries(esperado)) {
      const prop = await makeProperty(t, { policy });
      // a própria visão já aplica a política (primeira barreira)
      const [view] = await q(t, 'SELECT logradouro, numero_endereco, bairro, cidade, uf FROM marketing.v_public_property WHERE property_id = :id', { id: prop.id });
      assert.equal(view.logradouro ?? undefined, fields.logradouro, `${policy}: logradouro na visão`);
      assert.equal(view.numero_endereco ?? undefined, fields.numeroEndereco, `${policy}: número na visão`);
      assert.equal(view.bairro ?? undefined, fields.bairro, `${policy}: bairro na visão`);
      const model = await loadPublicProperty({ propertyId: prop.id }, tenant, t);
      assert.equal(model.policy, policy);
      const geo = { cidade: 'São Paulo', uf: 'SP' };
      assert.deepEqual(
        Object.fromEntries(['logradouro', 'numeroEndereco', 'bairro', 'enderecoPublico', 'cidade', 'uf'].filter((k) => model.payload[k] !== undefined && model.payload[k] !== null).map((k) => [k, model.payload[k]])),
        { ...fields, ...geo },
        policy
      );
      // segunda barreira: mesmo se um bruto completo chegar, a política manda
      const reforco = sanitizePublicFields({ logradouro: 'Rua das Acácias', numeroEndereco: '120', bairro: 'Jardim Europa', cidade: 'São Paulo', uf: 'SP' }, policy);
      assert.equal(reforco.payload.enderecoPublico, fields.enderecoPublico);
    }
  });
});

// 8
test('campos_de_preco_anterior_empreendimento_e_etapa_existem_nas_visoes_publicas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await makeProperty(t, { attrs: { pool: true, elevator: true, coveredParkingSpots: 2, suites: 1, bathrooms: 2, usableAreaM2: 98.5, concierge24h: true, secretNote: 'x' } });
    const offerId = await makeOffer(t, prop.id, 'SALE', 750000);
    await makeOffer(t, prop.id, 'RENT', 4200);
    await q(
      t,
      `INSERT INTO real_estate.property_price_history (id, group_id, company_id, offer_id, old_price, new_price, changed_at, changed_by, reason_code)
       VALUES (gen_random_uuid(), :g, :c, :o, 800000, 780000, now() - interval '2 day', :u, 'ADJUSTMENT'),
              (gen_random_uuid(), :g, :c, :o, 780000, 750000, now() - interval '1 day', :u, 'ADJUSTMENT')`,
      { g: tenant.groupId, c: tenant.companyId, o: offerId, u: tenant.userId }
    );
    await q(t, `INSERT INTO real_estate.property_documents (id, group_id, company_id, property_id, document_type, value_number, value_amount) VALUES
      (gen_random_uuid(), :g, :c, :p, 'CONDO_FEE', NULL, 1250.5), (gen_random_uuid(), :g, :c, :p, 'IPTU', '021.045.0123-4', 310)`,
    { g: tenant.groupId, c: tenant.companyId, p: prop.id });
    await q(t, `INSERT INTO real_estate.property_media (id, group_id, company_id, property_id, media_type, storage_key, position, quality_status) VALUES
      (gen_random_uuid(), :g, :c, :p, 'PHOTO', 'k/ok1', 1, 'APPROVED'), (gen_random_uuid(), :g, :c, :p, 'PHOTO', 'k/pend', 2, 'PENDING'), (gen_random_uuid(), :g, :c, :p, 'VIDEO', 'k/vid', 3, 'APPROVED')`,
    { g: tenant.groupId, c: tenant.companyId, p: prop.id });
    const { payload } = await loadPublicProperty({ propertyId: prop.id }, tenant, t);
    assert.equal(payload.precoAnterior, 780000, 'último preço antes da alteração');
    assert.equal(payload.precoVenda, 750000);
    assert.equal(payload.precoLocacao, 4200);
    assert.equal(payload.finalidade, 'VENDA_E_LOCACAO');
    assert.equal(payload.condominio, 1250.5);
    assert.equal(payload.iptu, 310, 'valor do IPTU, nunca a inscrição');
    assert.equal(payload.suites, 1);
    assert.equal(payload.banheiros, 2);
    assert.equal(payload.areaUtilM2, 98.5);
    assert.deepEqual(payload.features, ['piscina', 'elevador', 'portaria 24h', 'vaga coberta']);
    assert.equal(payload.fotosAutorizadas.length, 1, 'só foto aprovada');
    assert.match(payload.publicId, /^[0-9a-f-]{36}$/);
    assert.notEqual(payload.publicId, prop.id, 'id interno não sai');
    assert.ok(payload.publicadoEm);
    assert.ok(!JSON.stringify(payload).includes('021.045') && !JSON.stringify(payload).includes('secretNote'));
    assert.ok(!('primeiroNome' in payload) && !('property_id' in payload));
    const cols = (await q(t, "SELECT column_name FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = 'v_public_property'")).map((c) => c.column_name);
    assert.ok(!cols.some((c) => /primeiro|nome_pessoa|owner|proprietario|matricula|cpf|ocorrencia|document/.test(c)), cols.join(','));

    // obra: v_public_construction
    const [proj] = await q(t, `INSERT INTO construction.projects (id, group_id, company_id, name, status) VALUES (gen_random_uuid(), :g, :c, 'Residencial Aurora', 'ACTIVE') RETURNING id`, { g: tenant.groupId, c: tenant.companyId });
    await q(t, `INSERT INTO construction.project_stages (id, group_id, company_id, project_id, name, sequence, status, public_visible) VALUES
      (gen_random_uuid(), :g, :c, :p, 'Fundação', 1, 'DONE', true), (gen_random_uuid(), :g, :c, :p, 'Estrutura', 2, 'IN_PROGRESS', true),
      (gen_random_uuid(), :g, :c, :p, 'Auditoria interna de custos', 3, 'IN_PROGRESS', false)`, { g: tenant.groupId, c: tenant.companyId, p: proj.id });
    const obra = await loadPublicConstruction({ projectId: proj.id }, tenant, t);
    assert.deepEqual(Object.keys(obra.payload).sort(), ['etapaPublica', 'fotosAutorizadas', 'nomeEmpreendimento', 'publicadoEm']);
    assert.equal(obra.payload.nomeEmpreendimento, 'Residencial Aurora');
    assert.equal(obra.payload.etapaPublica, 'Estrutura', 'etapa não publicável nunca aparece');
    assert.ok(obra.payload.publicadoEm);
    const [semEtapa] = await q(t, `INSERT INTO construction.projects (id, group_id, company_id, name, status) VALUES (gen_random_uuid(), :g, :c, 'Sem etapa pública', 'ACTIVE') RETURNING id`, { g: tenant.groupId, c: tenant.companyId });
    await assert.rejects(() => loadPublicConstruction({ projectId: semEtapa.id }, tenant, t), (e) => e.code === 'MKT_SOURCE_NOT_FOUND');

    // primeiro nome só em v_relationship_facts
    const [pessoa] = await q(t, `INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, birth_or_foundation_date, status)
      VALUES (gen_random_uuid(), :g, :c, 'PF', 'Maria Aparecida da Silva', '1990-03-14', 'ACTIVE') RETURNING id`, { g: tenant.groupId, c: tenant.companyId });
    const fatos = await loadRelationshipFacts({ personId: pessoa.id, marco: 'BIRTHDAY' }, tenant, t);
    assert.deepEqual(fatos, [{ personId: pessoa.id, primeiroNome: 'Maria', marco: 'BIRTHDAY', dia: 14, mes: 3, dataMarco: null }]);
    const relCols = (await q(t, "SELECT column_name FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = 'v_relationship_facts'")).map((c) => c.column_name);
    assert.ok(relCols.includes('primeiro_nome'));
    assert.ok(!cols.includes('primeiro_nome'));
  });
});

// Allowlist configurável: permissão, auditoria e efeito real
test('allowlist_configuravel_exige_permissao_para_incluir_audita_e_vale_na_sanitizacao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const key = settings.PUBLIC_FIELDS_ALLOWLIST_KEY;
    const todos = settings.PUBLIC_FIELDS_DEFAULTS[key];
    // padrão do catálogo
    const padrao = await settings.readPublicFieldsConfig(tenant, t);
    assert.ok(padrao.allowlist.includes('condominio'));
    // remover é sempre permitido (sem permissão alguma)
    const semCondominio = settings.parseList(todos).filter((f) => f !== 'condominio').join(', ');
    settings.assertPublicFieldsChangeAllowed({ key, value: semCondominio, current: todos, permissions: [] });
    await upsertSetting(key, semCondominio, tenant, tenant.userId, t);
    const cfg = await settings.readPublicFieldsConfig(tenant, t);
    assert.ok(!cfg.allowlist.includes('condominio'));
    const out = sanitizePublicFields({ tipo: 'RESIDENTIAL', condominio: 900, iptu: 100 }, 'SO_BAIRRO', cfg);
    assert.deepEqual(out.payload, { tipo: 'RESIDENTIAL', iptu: 100 });
    assert.deepEqual(out.removedKeys, ['condominio']);
    // incluir sem permissão: 403 MKT_FORBIDDEN
    const atual = await getSetting(key, tenant, t, todos);
    assert.throws(
      () => settings.assertPublicFieldsChangeAllowed({ key, value: `${atual}, condominio`, current: atual, permissions: ['marketing:content:write'] }),
      (e) => e.statusCode === 403 && e.code === 'MKT_FORBIDDEN' && e.message === 'Você não tem permissão para esta ação de Marketing.'
    );
    // incluir com a permissão passa
    assert.deepEqual(settings.assertPublicFieldsChangeAllowed({ key, value: `${atual}, condominio`, current: atual, permissions: ['marketing:template:manage'] }), ['condominio']);
    // middleware do PUT: lê o valor vigente e recusa
    const req = { params: { key }, body: { value: `${atual}, condominio` }, auth: { ...tenant, permissions: [] }, withTenantTransaction: (fn) => fn(t) };
    const erro = await new Promise((resolve) => { settings.requireTemplateManageToAddPublicFields(req, {}, resolve); });
    assert.equal(erro && erro.code, 'MKT_FORBIDDEN');
    const reqOk = { ...req, auth: { ...req.auth, permissions: ['marketing:template:manage'] } };
    assert.equal(await new Promise((resolve) => { settings.requireTemplateManageToAddPublicFields(reqOk, {}, resolve); }), undefined);
    // chave estranha no catálogo é recusada
    await assert.rejects(() => upsertSetting(key, `${atual}, cpf_do_dono`, tenant, tenant.userId, t), (e) => e.statusCode === 400 && e.code === 'SETTING_INVALID_VALUE');
    // auditoria antes/depois
    await upsertSetting(key, todos, tenant, tenant.userId, t);
    const trilhas = await AuditLog.findAll({ where: { entityType: 'TenantSetting', action: 'settings.update', companyId: tenant.companyId }, order: [['occurredAt', 'DESC']], limit: 1, transaction: t });
    assert.equal(trilhas.length, 1);
    assert.ok(JSON.stringify(trilhas[0].beforeJson).includes('iptu') && !JSON.stringify(trilhas[0].beforeJson).includes('condominio'));
    assert.ok(JSON.stringify(trilhas[0].afterJson).includes('condominio'));
  });
});

test('caracteristicas_permitidas_configuraveis_filtram_features', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting(settings.PUBLIC_FIELDS_FEATURES_KEY, 'piscina, elevador', tenant, tenant.userId, t);
    const cfg = await settings.readPublicFieldsConfig(tenant, t);
    const out = sanitizePublicFields({ features: ['piscina', 'academia', 'Elevador', 'sauna'] }, 'SO_BAIRRO', cfg);
    assert.deepEqual(out.payload.features, ['piscina', 'Elevador']);
    assert.deepEqual(out.removedKeys, ['features[academia]', 'features[sauna]']);
    await assert.rejects(() => upsertSetting(settings.PUBLIC_FIELDS_FEATURES_KEY, 'piscina, heliponto', tenant, tenant.userId, t), (e) => e.code === 'SETTING_INVALID_VALUE');
  });
});

test('campos_minimos_ausentes_geram_422_mkt_public_fields_insufficient', () => {
  const sanitized = sanitizePublicFields({ tipo: 'RESIDENTIAL', ocorrenciaInterna: 'x' }, 'SO_BAIRRO').payload;
  assert.doesNotThrow(() => assertMinimumPublicFields(sanitized, ['tipo']));
  assert.throws(
    () => assertMinimumPublicFields(sanitized, ['tipo', 'cidade', 'precoVenda|precoLocacao']),
    (e) => e.statusCode === 422 && e.code === 'MKT_PUBLIC_FIELDS_INSUFFICIENT' && e.message === 'Faltam dados publicáveis para este tipo de conteúdo.'
      && JSON.stringify(e.details.missing) === JSON.stringify(['cidade', 'precoVenda|precoLocacao'])
  );
  assert.doesNotThrow(() => assertMinimumPublicFields({ tipo: 'A', cidade: 'B', precoLocacao: 10 }, ['tipo', 'cidade', 'precoVenda|precoLocacao']));
  assert.throws(() => assertMinimumPublicFields({ tipo: '  ', features: [] }, ['tipo', 'features']), (e) => e.details.missing.length === 2);
});

test('sanitizacao_e_registrada_em_checks_json_sem_violar_a_imutabilidade_da_versao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const [item] = await q(t, `INSERT INTO marketing.content_items (id, group_id, company_id, type, title) VALUES (gen_random_uuid(), :g, :c, 'NEW_PROPERTY', 'QA-M9 post') RETURNING id`, { g: tenant.groupId, c: tenant.companyId });
    const body = JSON.stringify({ texto: 'oi' });
    const [ver] = await q(
      t,
      `INSERT INTO marketing.content_versions (id, group_id, company_id, content_item_id, version_no, body_json, content_hash)
       VALUES (gen_random_uuid(), :g, :c, :i, 1, CAST(:b AS jsonb), :h) RETURNING id`,
      { g: tenant.groupId, c: tenant.companyId, i: item.id, b: body, h: sha(body) }
    );
    const report = sanitizePublicFields({ texto: 'CPF 123.456.789-09', ocorrenciaInterna: 'x' }, 'SO_BAIRRO');
    assert.equal(await recordSanitizationChecks(ver.id, report, tenant, t), true);
    const [row] = await q(t, 'SELECT checks_json FROM marketing.content_versions WHERE id = :id', { id: ver.id });
    assert.deepEqual(row.checks_json.sanitization.removedKeys, ['ocorrenciaInterna']);
    assert.deepEqual(row.checks_json.sanitization.redactedPatterns, ['CPF']);
    assert.equal(row.checks_json.sanitization.policy, 'SO_BAIRRO');
  });
});

test('politica_de_endereco_do_imovel_e_alterada_pelo_servico_com_auditoria_e_validada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await makeProperty(t);
    await assert.rejects(() => updateProperty(prop.id, { publicAddressPolicy: 'TUDO' }, tenant.userId, t, tenant), (e) => e.code === 'PROPERTY_VALIDATION');
    await updateProperty(prop.id, { publicAddressPolicy: 'oculto' }, tenant.userId, t, tenant);
    const model = await loadPublicProperty({ propertyId: prop.id }, tenant, t);
    assert.equal(model.policy, 'OCULTO');
    assert.equal(model.payload.enderecoPublico, 'Endereço sob consulta');
    assert.ok(!('bairro' in model.payload));
    const trilhas = await AuditLog.findAll({ where: { entityType: 'Property', entityId: prop.id, action: 'property.update' }, transaction: t });
    assert.equal(trilhas.length, 1);
    assert.equal(trilhas[0].beforeJson.publicAddressPolicy, 'SO_BAIRRO');
    assert.equal(trilhas[0].afterJson.publicAddressPolicy, 'OCULTO');
  });
});

test('publicado_em_e_mantido_pelo_banco_e_rascunho_nao_entra_na_visao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const rascunho = await makeProperty(t, { status: 'DRAFT' });
    assert.equal(rascunho.published_at, null);
    await assert.rejects(() => loadPublicProperty({ propertyId: rascunho.id }, tenant, t), (e) => e.code === 'MKT_SOURCE_NOT_FOUND');
    await q(t, "UPDATE real_estate.properties SET publication_status = 'PUBLISHED' WHERE id = :id", { id: rascunho.id });
    const [after1] = await q(t, 'SELECT published_at FROM real_estate.properties WHERE id = :id', { id: rascunho.id });
    assert.ok(after1.published_at);
    const model = await loadPublicProperty({ publicId: rascunho.public_id }, tenant, t);
    assert.ok(model.payload.publicadoEm);
  });
});

test('visoes_publicas_respeitam_a_rls_entre_empresas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await makeProperty(t);
    const outra = { ...tenant, companyId: uid() };
    await assert.rejects(() => loadPublicProperty({ propertyId: prop.id }, outra, t), (e) => e.code === 'MKT_SOURCE_NOT_FOUND');
    await assert.rejects(() => loadPublicProperty({}, tenant, t), (e) => e.code === 'MKT_SOURCE_REQUIRED');
    await assert.rejects(() => loadPublicProperty({ propertyId: prop.id }, {}, t), (e) => e.code === 'MKT_TENANT_REQUIRED');
  });
});
