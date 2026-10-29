'use strict';

// M9-D700 — mascaramento dos campos RESTRICTED, catálogo de permissões, mapa ABAC e chave de cache. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../../../src/features/analytics/security');

const { maskRestricted, parseExtraFields, parseDomainMap, mergeDomainMap, domainPermissionOf, buildCacheKey } = security;

test('m9d700 CPF, conta, e-mail e telefone mascarados no detalhe (formatos do livro)', () => {
  const linha = {
    cpf: '123.456.789-01', customer_cpf: '12345678901', bank_account: '000123-4567', email: 'joao@dominio.com',
    telefone: '(11) 91234-4321', celular: '+55 11 91234-4321', party_name: 'João da Silva', cnpj: '12.345.678/0001-90',
    nome: 'Livre', valor: 1500.5,
  };
  const { data, maskedCount } = maskRestricted(linha);
  assert.equal(data.cpf, '***.456.789-**');
  assert.equal(data.customer_cpf, '***.456.789-**');
  assert.equal(data.bank_account, '****4567');
  assert.equal(data.email, 'j***@dominio.com');
  assert.equal(data.telefone, '(11) *****-4321');
  assert.equal(data.celular, '(11) *****-4321');
  assert.equal(data.party_name, 'J. S.');
  assert.equal(data.cnpj, '**.***.***/0001-**');
  assert.equal(data.nome, 'Livre');
  assert.equal(data.valor, 1500.5);
  assert.equal(maskedCount, 8);
  assert.equal(linha.cpf, '123.456.789-01', 'a entrada não é alterada');
  for (const original of ['123.456.789-01', '12345678901', '000123-4567', 'joao@dominio.com', '91234-4321', '12.345.678/0001-90']) {
    assert.ok(!JSON.stringify(data).includes(original), `vazou ${original}`);
  }
});

test('m9d700 campo RESTRICTED sai mascarado em qualquer profundidade, em listas e dentro de texto livre', () => {
  const { data } = maskRestricted({
    linhas: [{ cliente: { documento: '1234567', remuneracao: 9500, salario: '8000,00' } }],
    observacao: 'Falar com maria@empresa.com.br sobre o CPF 111.222.333-44 e o CNPJ 11.222.333/0001-81.',
  });
  assert.equal(data.linhas[0].cliente.documento, '[RESTRITO]');
  assert.equal(data.linhas[0].cliente.remuneracao, '[RESTRITO]');
  assert.equal(data.linhas[0].cliente.salario, '[RESTRITO]');
  assert.ok(data.observacao.includes('m***@empresa.com.br'));
  assert.ok(data.observacao.includes('***.222.333-**'));
  assert.ok(data.observacao.includes('**.***.***/0001-**'));
  assert.ok(!/maria@|111\.222|11\.222\.333/.test(data.observacao));
});

test('m9d700 o administrador só ACRESCENTA campos mascarados e nenhum contexto desliga o mascaramento', () => {
  assert.equal(parseExtraFields('nenhum').size, 0);
  const extra = parseExtraFields('Número do Cartão; apelido_interno');
  const { data } = maskRestricted({ numero_do_cartao: '4111', apelidoInterno: 'x', cpf: '12345678901', ok: 'livre' }, extra);
  assert.equal(data.numero_do_cartao, '[RESTRITO]');
  assert.equal(data.apelidoInterno, '[RESTRITO]');
  assert.equal(data.cpf, '***.456.789-**', 'campos do livro continuam mascarados mesmo com lista extra');
  assert.equal(data.ok, 'livre');
  // maskRestricted não recebe usuário nem permissão: não há caminho de bypass
  assert.equal(maskRestricted.length <= 2, true);
});

test('m9d700 catálogo tem as 12 permissões e a migration usa a mesma lista', () => {
  assert.equal(security.ANALYTICS_PERMISSIONS.length, 12);
  assert.deepEqual([...security.ANALYTICS_PERMISSION_CODES].sort(), [
    'analytics:accept', 'analytics:alert:ack', 'analytics:alert:manage', 'analytics:audit:read', 'analytics:brief:read', 'analytics:drilldown',
    'analytics:export', 'analytics:manage', 'analytics:read', 'analytics:read:group', 'analytics:read:tech', 'analytics:rebuild',
  ]);
  const migration = require('../../../migrations/20260101009700-analytics-permissions-and-access-log');
  assert.ok(migration.up && migration.down);
});

test('m9d700 mapa domínio x permissão: padrão do livro, override do administrador e entrada inválida ignorada', () => {
  const padrao = mergeDomainMap(undefined);
  assert.equal(domainPermissionOf(padrao, 'FINANCE'), 'finance:read');
  assert.equal(domainPermissionOf(padrao, 'RENTAL'), 'legal:read');
  assert.equal(domainPermissionOf(padrao, 'LEGAL'), 'legal:read');
  assert.equal(domainPermissionOf(padrao, 'MARKETING'), 'crm:opportunities:read');
  assert.equal(domainPermissionOf(padrao, 'SUPPORT'), 'crm:opportunities:read');
  assert.equal(domainPermissionOf(padrao, 'TECH_AI'), 'analytics:read:tech');
  assert.equal(domainPermissionOf(padrao, 'GENERAL'), 'analytics:read');
  const custom = mergeDomainMap('Financeiro=finance:special; Obras=ISSO NAO E PERMISSAO; Locação=rental:read');
  assert.equal(domainPermissionOf(custom, 'FINANCE'), 'finance:special');
  assert.equal(domainPermissionOf(custom, 'CONSTRUCTION'), 'construction:read', 'entrada inválida cai no padrão (falha fechada)');
  assert.equal(domainPermissionOf(custom, 'RENTAL'), 'rental:read');
  assert.equal(parseDomainMap('lixo').size, 0);
});

test('m9d700 chave de cache muda com permissões, empresa e recorte de carteira', () => {
  const base = { groupId: 'g', companyId: 'c', permissions: ['analytics:read', 'finance:read'] };
  const k1 = buildCacheKey(base, 'dashboard:finance', { a: 1 });
  assert.equal(k1, buildCacheKey({ ...base, permissions: ['finance:read', 'analytics:read'] }, 'dashboard:finance', { a: 1 }), 'ordem das permissões não importa');
  assert.notEqual(k1, buildCacheKey({ ...base, permissions: ['analytics:read'] }, 'dashboard:finance', { a: 1 }), 'permissão diferente, chave diferente');
  assert.notEqual(k1, buildCacheKey({ ...base, companyId: 'c2' }, 'dashboard:finance', { a: 1 }));
  assert.notEqual(k1, buildCacheKey(base, 'dashboard:finance', { a: 1 }, { mode: 'SELF', userIds: ['u1'] }), 'carteira própria tem chave própria');
  assert.notEqual(k1, buildCacheKey(base, 'dashboard:finance', { a: 2 }));
});

test('m9d700 recorte por carteira: filtro SQL só existe para quem tem a carteira própria', () => {
  assert.deepEqual(security.ownerFilter({ mode: 'ALL', userIds: [] }), { clause: 'TRUE', replacements: {} });
  const f = security.ownerFilter({ mode: 'SELF', userIds: ['u1'] }, 'r.owner_user_id');
  assert.match(f.clause, /r\.owner_user_id = ANY/);
  assert.throws(() => security.ownerFilter({ mode: 'SELF', userIds: [] }, 'x; DROP TABLE y'));
  const teams = security.parseTeams('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb, lixo; nenhum');
  assert.deepEqual([...teams.get('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')], ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']);
});

test('m9d700 variações comuns de nome de campo saem mascaradas e nomes livres continuam livres (reabertura)', () => {
  const linha = {
    phone_number: '11987654321', customer_phone_number: '11987654321', telefone_contato: '11987654321',
    numeroConta: '123456', conta_corrente: '0012345', cpfCliente: '12345678909', cpf_titular: '12345678909',
    cnpjEmpresa: '11222333000181', nome_da_parte: 'Ana Lima', cpfTitular: '12345678909', emailContato: 'ana@x.com',
    nome: 'Ana', valor: 10, chave: 'k', party_id: 'abc', account_id: 'u1', document_type: 'RG',
  };
  const { data } = maskRestricted(linha);
  for (const k of ['phone_number', 'customer_phone_number', 'telefone_contato']) assert.equal(data[k], '(11) *****-4321', k);
  assert.equal(data.numeroConta, '****3456');
  assert.equal(data.conta_corrente, '****2345');
  assert.equal(data.cpfCliente, '***.456.789-**');
  assert.equal(data.cpf_titular, '***.456.789-**');
  assert.equal(data.cpfTitular, '***.456.789-**');
  assert.equal(data.cnpjEmpresa, '**.***.***/0001-**');
  assert.equal(data.nome_da_parte, 'A. L.');
  assert.equal(data.emailContato, 'a***@x.com');
  assert.deepEqual([data.nome, data.valor, data.chave, data.party_id, data.account_id, data.document_type], ['Ana', 10, 'k', 'abc', 'u1', 'RG']);
});

test('m9d700 CPF, CNPJ e telefone sem pontuação em texto livre são mascarados (só com dígito verificador válido)', () => {
  const { data } = maskRestricted({
    nota: '12345678909', obs: 'cnpj 11222333000181 e fone (11) 98765-4321 ou 11987654321', protocolo: 'pedido 12345678900',
  });
  assert.equal(data.nota, '***.456.789-**');
  assert.ok(data.obs.includes('**.***.***/0001-**') && !/11222333|98765|987654321/.test(data.obs));
  assert.equal(data.protocolo, 'pedido 12345678900', 'número de 11 dígitos sem dígito verificador válido não é CPF');
});
