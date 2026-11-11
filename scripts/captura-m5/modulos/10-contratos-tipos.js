'use strict';
/**
 * Captura do fechamento do Marco 5 — Contratos: tipos de contrato (Caderno §3), criação pela rota
 * literal do Guia §14 (POST /contracts), evento contract.created e permissão de criação.
 * Contexto gravado em R.ctx com prefixo `ct` (os módulos 11 a 15 reaproveitam).
 */
const TIPOS = {
  SALE_CASH: 'M5-A0018-77e34f',
  SALE_FINANCED: 'M5-A0019-64e8b2',
  SALE_TRADE: 'M5-A0020-87a024',
  SALE_INSTALLMENTS: 'M5-A0021-e335f3',
  LEASE_RESIDENTIAL: 'M5-A0022-0656df',
  LEASE_COMMERCIAL: 'M5-A0023-6eecaf',
  LEASE_SEASONAL: 'M5-A0024-a3b990',
  PROPERTY_ADMIN: 'M5-A0025-7cf0c1',
};
const VINCULADOS = { ADDENDUM: 'M5-A0027-72d604', KEY_DELIVERY: 'M5-A0028-81a9e0', USED_PROPERTY_DELIVERY: 'M5-A0029-b27d16' };

module.exports = async function contratosTipos(R) {
  const sfx = String(Date.now()).slice(-7);
  R.ctx.ctSfx = sfx;
  R.ctx.ctTipos = {};

  await R.http({ id: 'CT-001', req: ['M5-A0022-0656df'], titulo: 'Preparação: imóvel fictício dos contratos', quem: 'A:gestor', metodo: 'POST', rota: '/properties', corpo: { title: `Imóvel Contratos ${sfx}`, internalCode: `CT-${sfx}`, propertyType: 'RESIDENTIAL' }, esperado: { status: 201 }, guardar: (b, c) => { c.ctImovel = b.data.id; } });

  let n = 1;
  for (const [tipo, req] of Object.entries(TIPOS)) {
    n += 1;
    await R.http({
      id: `CT-${String(n).padStart(3, '0')}`, req: [req, 'M5-A0208-04872a'], titulo: `Cria contrato do tipo ${tipo} pela rota literal do livro (POST /contracts)`, quem: 'A:gestor', metodo: 'POST', rota: '/contracts',
      corpo: (c) => ({ contractType: tipo, totalValue: 1000 * n, propertyId: c.ctImovel }), esperado: { status: 201 },
      guardar: (b, c) => { c.ctTipos[tipo] = b.data.id; },
    });
  }

  await R.http({ id: 'CT-010', req: ['M5-A0026-efe161'], titulo: 'CONSTRUCTION sem obra vinculada é recusado (regra do tipo)', quem: 'A:gestor', metodo: 'POST', rota: '/legal/contracts', corpo: { contractType: 'CONSTRUCTION', totalValue: 250000 }, esperado: { status: 400, codigo: 'LEGAL_CONTRACT_CONSTRUCTION_PROJECT_REQUIRED' } });
  await R.servico({
    id: 'CT-011', req: ['M5-A0026-efe161'], titulo: 'Preparação: obra fictícia (construction.projects) para o contrato de empreitada', chamada: 'projectsService.createProject({ name })',
    fn: () => R.comTenant('A:gestor', (tx, t) => require('../../../src/features/construction/projects.service').createProject({ groupId: t.groupId, companyId: t.companyId, name: `Obra Contratos ${sfx}` }, t.userId, tx).then((p) => ({ id: p.id, name: p.name }))),
    esperado: {}, guardar: (r, c) => { c.ctObra = r.id; },
  });
  await R.http({ id: 'CT-012', req: ['M5-A0026-efe161', 'M5-A0208-04872a'], titulo: 'Cria contrato CONSTRUCTION vinculado à obra (POST /contracts)', quem: 'A:gestor', metodo: 'POST', rota: '/contracts', corpo: (c) => ({ contractType: 'CONSTRUCTION', totalValue: 250000, constructionProjectId: c.ctObra }), esperado: { status: 201 }, guardar: (b, c) => { c.ctTipos.CONSTRUCTION = b.data.id; } });

  await R.sqlTenant({
    id: 'CT-013', req: [...Object.values(TIPOS), 'M5-A0026-efe161'], quem: 'A:leitura', descricao: 'Os 9 contratos criados, um por tipo do livro, gravados em DRAFT com numeração por prefixo do tipo (RLS do tenant A)',
    sql: 'SELECT contract_type, status, contract_number, construction_project_id IS NOT NULL AS com_obra FROM legal.contracts WHERE id IN (:ids) ORDER BY contract_type',
    replacements: (c) => ({ ids: Object.values(c.ctTipos) }),
    avaliar: (rows, c) => rows.length === 9 && rows.every((r) => r.status === 'DRAFT' && /^(VEN|LOC|ADM|OBR)-\d{4}-\d{4}$/.test(r.contract_number)) && rows.find((r) => r.contract_type === 'CONSTRUCTION').com_obra === true && Object.keys(c.ctTipos).length === 9,
  });

  let m = 13;
  const PREFIXO = { ADDENDUM: 'ADT', KEY_DELIVERY: 'CHV', USED_PROPERTY_DELIVERY: 'IMU' };
  for (const [tipo, req] of Object.entries(VINCULADOS)) {
    m += 1;
    await R.http({ id: `CT-0${m}`, req: [req], titulo: `Tipo ${tipo} (Caderno §3) é vinculado: sem contrato principal é recusado`, quem: 'A:gestor', metodo: 'POST', rota: '/contracts', corpo: { contractType: tipo, totalValue: 1 }, esperado: { status: 400, codigo: 'LEGAL_CONTRACT_PARENT_REQUIRED' } });
    await R.http({
      id: `CT-0${m}b`, req: [req, 'M5-A0208-04872a'], titulo: `Cria contrato ${tipo} vinculado ao contrato principal (herda o imóvel; número ${PREFIXO[tipo]})`, quem: 'A:gestor', metodo: 'POST', rota: '/contracts',
      corpo: (c) => ({ contractType: tipo, totalValue: 1, parentContractId: c.ctTipos.LEASE_RESIDENTIAL }), esperado: { status: 201 },
      guardar: (b, c) => { c.ctVinc = c.ctVinc || {}; if (b && b.data) c.ctVinc[tipo] = b.data.id; },
    });
  }
  await R.http({ id: 'CT-016c', req: ['M5-A0027-72d604', 'M5-A0310-1efdf0'], titulo: 'Contrato principal de outra empresa não é aceito', quem: 'B:gestor', metodo: 'POST', rota: '/contracts', corpo: (c) => ({ contractType: 'ADDENDUM', parentContractId: c.ctTipos.LEASE_RESIDENTIAL }), esperado: { status: 404, codigo: 'LEGAL_CONTRACT_PARENT_NOT_FOUND' } });
  await R.http({ id: 'CT-016d', req: ['M5-A0027-72d604'], titulo: 'Vinculado não serve de contrato principal', quem: 'A:gestor', metodo: 'POST', rota: '/contracts', corpo: (c) => ({ contractType: 'ADDENDUM', parentContractId: c.ctVinc.ADDENDUM }), esperado: { status: 409, codigo: 'LEGAL_CONTRACT_PARENT_INVALID' } });
  await R.sqlTenant({
    id: 'CT-016e', req: Object.values(VINCULADOS), quem: 'A:leitura', descricao: 'Os três tipos vinculados gravados com parent_contract_id, imóvel herdado e numeração própria',
    sql: 'SELECT v.contract_type, v.contract_number, v.parent_contract_id = p.id AS vinculado, v.property_id = p.property_id AS imovel_herdado FROM legal.contracts v JOIN legal.contracts p ON p.id = :pai WHERE v.id IN (:ids) ORDER BY v.contract_type',
    replacements: (c) => ({ pai: c.ctTipos.LEASE_RESIDENTIAL, ids: Object.values(c.ctVinc) }),
    avaliar: (r) => r.length === 3 && r.every((x) => x.vinculado && x.imovel_herdado && new RegExp(`^${PREFIXO[x.contract_type]}-\\d{4}-\\d{4}$`).test(x.contract_number)),
  });
  await R.http({ id: 'CT-017', req: ['M5-A0098-ef5e55', 'M5-A0027-72d604'], titulo: 'Aditivo (legal.addenda) referencia a versão base: contrato sem versão não recebe aditivo', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctTipos.LEASE_RESIDENTIAL}/amendments`, corpo: { reason: 'Reajuste fictício', changes: [{ field: 'totalValue', oldValue: 6000, newValue: 6100 }] }, esperado: { status: 409, codigo: 'LEGAL_CONTRACT_AMENDMENT_BASE_VERSION_REQUIRED' } });

  await R.http({ id: 'CT-019', req: ['M5-A0208-04872a'], titulo: 'Tipo fora do catálogo é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/contracts', corpo: { contractType: 'TIPO_INVENTADO' }, esperado: { status: 400, codigo: 'LEGAL_CONTRACT_VALIDATION' } });
  await R.http({ id: 'CT-020', req: ['M5-A0208-04872a'], titulo: 'Perfil leitura (sem legal:create) não cria contrato pela rota do livro', quem: 'A:leitura', metodo: 'POST', rota: '/contracts', corpo: { contractType: 'SALE_CASH' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.http({ id: 'CT-021', req: ['M5-A0208-04872a'], titulo: 'Sem login a rota do livro recusa', quem: 'anonimo', metodo: 'POST', rota: '/contracts', corpo: { contractType: 'SALE_CASH' }, esperado: { status: 401 } });

  await R.sqlTenant({
    id: 'CT-022', req: ['M5-A0126-035294', 'M5-A0220-741ba3'], quem: 'A:leitura', descricao: 'Evento contract.created publicado no outbox para cada contrato criado (mesma transação)',
    sql: "SELECT aggregate_id, event_type, payload_json->>'contractType' AS tipo FROM integration.outbox_events WHERE event_type = 'contract.created' AND aggregate_id IN (:ids)",
    replacements: (c) => ({ ids: Object.values(c.ctTipos) }),
    avaliar: (rows) => rows.length === 9 && new Set(rows.map((r) => r.aggregate_id)).size === 9,
  });
  await R.sqlTenant({
    id: 'CT-023', req: ['M5-A0018-77e34f', 'M5-A0310-1efdf0'], quem: 'B:leitura', descricao: 'Tenant B não enxerga nenhum dos contratos do tenant A (RLS)',
    sql: 'SELECT count(*)::int AS n FROM legal.contracts WHERE id IN (:ids)', replacements: (c) => ({ ids: Object.values(c.ctTipos) }),
    avaliar: (rows) => rows[0].n === 0,
  });
};
