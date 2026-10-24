'use strict';

// Item 3 do ciclo de auditoria externa (Marco 3) — crm.carts ("Carrinho de imóveis
// compartilhável. Não existe NADA hoje."). Contrato bruto — Guia do Marcelo §14 ("Carrinho de
// imóveis"):
//   "Usuário seleciona imóveis de uma oportunidade."
//   "Gera link/coleção com expiração e tracking."
//   "Não expõe observações internas nem endereço sensível."
//   "Visualização/clique podem gerar eventos para CRM."
//   "Carrinho versionado para saber o que foi enviado."
//
// BLOQUEIO DE INFRAESTRUTURA (não é falha de lógica): as tabelas "crm"."carts"/
// "crm"."cart_versions"/"crm"."cart_share_routing" (migration
// 20260101000286-create-crm-carts.js) NÃO foram aplicadas ao banco nesta sessão — a credencial
// de DDL em `.env.migration.local` (DB_MIGRATION_USER=nayara_migration) foi rejeitada pelo
// Postgres ("password authentication failed"), e o usuário de runtime (DATABASE_URL) não tem
// CREATE em nenhum schema (confirmado: "permission denied for schema crm" ao tentar criar uma
// tabela de teste diretamente). Sem acesso para corrigir a senha nesta sessão, a migration não
// pôde ser executada.
//
// Este teste faz uma checagem de pré-condição explícita: se a tabela "crm"."carts" existir,
// roda a suíte completa de verdade contra o banco; se não existir, marca os testes como SKIP
// com o motivo exato (nunca finge sucesso, nunca é silenciosamente removido da suíte).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('./testHelpers');

let tenant;
let cartsTableExists = false;

before(async () => {
  tenant = await getSeedTenant();
  const [rows] = await sequelize.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'crm' AND table_name = 'carts'`
  );
  cartsTableExists = rows.length > 0;
});

after(async () => {
  await sequelize.close();
});

const SKIP_REASON =
  'crm.carts ainda não existe no banco: migration 20260101000286-create-crm-carts.js não pôde ser aplicada ' +
  '(credencial DB_MIGRATION_USER em .env.migration.local rejeitada pelo Postgres nesta sessão). Rode ' +
  '"DB_USER=nayara_migration DB_PASSWORD=<senha correta> npm run migrate" e reexecute este teste.';

test('carts.service: cria carrinho versionado, gera link público sanitizado e registra eventos de view/click', async (t) => {
  if (!cartsTableExists) {
    t.skip(SKIP_REASON);
    return;
  }

  const cartsService = require('../src/features/crm/carts.service');
  const opportunitiesService = require('../src/features/crm/opportunity.service');
  const personService = require('../src/features/people/person.service');
  const propertiesService = require('../src/features/properties/properties.service');
  const propertyOccurrencesService = require('../src/features/properties/propertyInternalOccurrences.service');
  const { OutboxEvent, Cart, CartVersion, CartShareRouting } = require('../src/models');

  // ATENÇÃO (correção pós-entrega): o endpoint público (getPublicCartByToken/
  // recordPublicCartClick) resolve o tenant via CartShareRouting SEM contexto de transação —
  // exatamente como acontece numa requisição HTTP real (sem JWT) — e portanto precisa que o
  // carrinho/link já estejam de fato COMMITADOS no banco antes de serem lidos por essa segunda
  // conexão/transação independente. `withRollbackTenantTransaction` (usada no resto da suíte)
  // nunca pode terminar em commit — seu `finally` sempre chama `transaction.rollback()`, e dar
  // commit manual ali dentro quebra esse contrato ("Transaction cannot be rolled back because
  // it has been finished with state: commit"). A causa raiz do erro reportado estava AQUI, não
  // em carts.service.js (que nunca commita/rollback a transaction recebida — confirmado por
  // grep, mesmo padrão de todo service do projeto). Fix: usar `withTenantTransaction`
  // (gerenciada pelo próprio Sequelize — commit automático ao final do callback, só essa
  // chamada) para a fase de setup que precisa ficar visível pro endpoint público, e limpar os
  // dados depois numa transação própria, comitada por fora.
  const suffix = uniqueSuffix();
  const { cartId, propertyId, token } = await withTenantTransaction(tenant, async (transaction) => {
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead Carrinho ${suffix}` },
      tenant.userId,
      transaction
    );
    const opportunity = await opportunitiesService.createOpportunity(
      { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, stage: 'MATCHING', nextAction: 'Enviar carrinho', nextActionDueAt: new Date(Date.now() + 86400000) },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel Carrinho ${suffix}`, internalCode: `CART-${suffix}`, propertyType: 'RESIDENTIAL', addressLine: 'Rua Sensível, 123', registryNumber: `MAT-CART-${suffix}` },
      tenant.userId,
      transaction
    );
    await propertyOccurrencesService.createOccurrence(
      property.id,
      { occurrenceType: 'RISK', description: 'Observação interna sigilosa — nunca pode aparecer no carrinho público' },
      tenant.userId,
      transaction
    );

    const cart = await cartsService.createCart(opportunity.id, { propertyIds: [property.id] }, tenant.userId, transaction);
    assert.equal(cart.currentVersion, 1);

    const updated = await cartsService.updateCartItems(cart.id, [property.id], tenant.userId, transaction);
    assert.equal(updated.currentVersion, 2, 'mudar os itens do carrinho precisa criar uma NOVA versão, nunca sobrescrever');

    const routing = await cartsService.generateShareLink(cart.id, transaction);
    assert.ok(routing.token);

    return { cartId: cart.id, propertyId: property.id, token: routing.token };
  });

  try {
    const publicView = await cartsService.getPublicCartByToken(token, sequelize);
    assert.equal(publicView.version, 2);
    const serialized = JSON.stringify(publicView);
    assert.equal(serialized.includes('Rua Sensível'), false, 'endereço sensível nunca pode aparecer no carrinho público');
    assert.equal(serialized.includes('sigilosa'), false, 'observação interna nunca pode aparecer no carrinho público');
    assert.equal(serialized.includes('MAT-CART'), false, 'matrícula não pode aparecer no carrinho público');

    // integration.outbox_events também tem RLS — a leitura de verificação precisa do mesmo
    // contexto de tenant (SET LOCAL) usado pelo resto da suíte, senão a policy filtra tudo e
    // "não encontrado" fica indistinguível de "RLS bloqueou a leitura".
    const viewEvent = await withTenantTransaction(tenant, (transaction) =>
      OutboxEvent.findOne({ where: { eventType: 'crm.cart.viewed', aggregateId: cartId }, transaction })
    );
    assert.ok(viewEvent, 'visualização do carrinho público precisa gerar evento crm.cart.viewed');

    await cartsService.recordPublicCartClick(token, propertyId, sequelize);
    const clickEvent = await withTenantTransaction(tenant, (transaction) =>
      OutboxEvent.findOne({ where: { eventType: 'crm.cart.property_clicked', aggregateId: cartId }, transaction })
    );
    assert.ok(clickEvent, 'clique em imóvel do carrinho público precisa gerar evento crm.cart.property_clicked');
  } finally {
    // Limpeza manual, fora de qualquer transação de rollback — os dados foram commitados de
    // propósito (ver nota acima) para simular o cenário real de link público persistido, então
    // precisam ser apagados explicitamente para não sujar o banco de dev compartilhado.
    // CartShareRouting não tem RLS (ver carts.service.js); Cart/CartVersion/OutboxEvent têm, e
    // por isso precisam de uma transação com tenant setado para o DELETE ser permitido.
    await CartShareRouting.destroy({ where: { cartId } });
    await withTenantTransaction(tenant, async (transaction) => {
      await OutboxEvent.destroy({ where: { aggregateId: cartId }, transaction });
      await CartVersion.destroy({ where: { cartId }, transaction });
      await Cart.destroy({ where: { id: cartId }, transaction });
    });
  }
});
