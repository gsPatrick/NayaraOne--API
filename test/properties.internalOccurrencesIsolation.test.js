'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const occurrencesService = require('../src/features/properties/propertyInternalOccurrences.service');

// CRM-TS-006 (auditoria externa Abacus AI, 11/10/2026): "Portal consulta ocorrência interna
// -> Nunca retorna." A auditora não conseguiu verificar isso porque não existe ainda nenhum
// endpoint de portal público no sistema — TODAS as rotas (inclusive /properties/:id) exigem
// authMiddleware + permissão (properties.routes.js:10), e as rotas de ocorrência interna
// exigem a permissão SEPARADA 'properties:internal' (distinta de 'properties:read'). Este
// teste prova a parte que É verificável em código: o caminho de leitura "normal" autenticado
// do imóvel (getProperty/listProperties, o mesmo serializer usado por qualquer tela ou futura
// API externa) NUNCA inclui PropertyInternalOccurrence, mesmo quando a ocorrência existe.
//
// NÃO APLICÁVEL ainda: não há portal/API pública anônima implementada nesta fase do produto
// para testar "chamada anônima não retorna ocorrência" ponta a ponta — quando esse endpoint
// existir, este arquivo deve ganhar um teste equivalente contra ele.

after(async () => {
  await sequelize.close();
});

test('CRM-TS-006: getProperty/listProperties (leitura autenticada padrão) nunca inclui PropertyInternalOccurrence mesmo quando ela existe', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel com ocorrência interna ${uniqueSuffix()}`,
        internalCode: `IC-OCC-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );

    await occurrencesService.createOccurrence(
      property.id,
      { occurrenceType: 'OWNER_NOTE', description: 'Proprietário pediu sigilo total sobre esta negociação.' },
      tenant.userId,
      transaction
    );

    const fetched = await propertiesService.getProperty(property.id, transaction);
    const fetchedJson = fetched.toJSON();
    assert.equal(fetchedJson.occurrences, undefined, 'getProperty não deve ter chave "occurrences"');
    assert.equal(JSON.stringify(fetchedJson).includes('Proprietário pediu sigilo'), false, 'conteúdo da ocorrência interna não pode vazar na serialização do imóvel');

    const list = await propertiesService.listProperties(transaction, {});
    const fromList = list.find((p) => p.id === property.id);
    assert.ok(fromList);
    assert.equal(fromList.toJSON().occurrences, undefined, 'listProperties também não deve incluir ocorrências internas');
  });
});

test('CRM-TS-006: endpoints de ocorrência interna exigem a permissão dedicada "properties:internal" (distinta de "properties:read")', async () => {
  const fs = require('node:fs');
  const routesSource = fs.readFileSync(
    require.resolve('../src/features/properties/properties.routes.js'),
    'utf8'
  );
  const occurrenceRouteLines = routesSource
    .split('\n')
    .filter((line) => line.includes('/occurrences'));
  assert.ok(occurrenceRouteLines.length >= 2, 'deve haver rotas POST e GET para /properties/:id/occurrences');
  for (const line of occurrenceRouteLines) {
    assert.match(line, /requirePermission\('properties:internal'\)/, `rota de ocorrência interna deve exigir 'properties:internal': ${line}`);
  }
});
