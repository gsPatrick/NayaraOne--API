'use strict';

// Apoio dos testes da NFS-e sobre o registro de integração (M9-D241): pedido de nota pelo serviço do Fiscal, leitura do envio (integration.dispatches), troca da falha injetada na
// connection e espera do emissor de laboratório (a nota autoriza 1,5 s depois do pedido). Cada teste roda numa transação com rollback, no banco descartável.
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const crypto = require('node:crypto');
const nfseService = require('../../../src/features/correspondent/fiscal/nfse.service');
const { InvoiceRequest, TaxDocument } = require('../../../src/models');
const { ensureFiscalConnection } = require('../../../src/features/correspondent/fiscal/nfse/nfse.connection');
const nfseSandbox = require('../../../src/features/correspondent/adapters/NfseAdapter');
const { resetInjectedFaults } = require('../../../src/features/integrations/adapters/legacy/fiscal.adapters');

const { sandboxStats } = nfseSandbox;
/** Zera o emissor de laboratório e as falhas já aplicadas: o cenário repetido no mesmo banco (connection e chave iguais) recebe a falha de novo. */
const resetSandbox = () => { nfseSandbox.resetSandbox(); resetInjectedFaults(); };

let tenant;
const carregar = async () => { tenant = await getSeedTenant(); return tenant; };
const ctxDe = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });
const a = () => [tenant.userId, tenant.groupId, tenant.companyId];

/** Pede a nota (origem nova a cada chamada, salvo `sourceId`). `extra` sobrescreve o corpo. */
const pedir = (t, extra = {}) => nfseService.requestInvoice({ sourceType: 'SERVICE_ORDER', sourceId: crypto.randomUUID(), amount: 2500, description: `Comissão de intermediação ${uniqueSuffix()}`, takerTaxId: '52998224725', takerName: 'Maria Souza', ...extra }, ...a(), t);
const consultar = (t, id) => nfseService.checkInvoiceStatus(id, ...a(), t);
const cancelar = (t, id, motivo) => nfseService.cancelInvoice(id, motivo, ...a(), t);
const esperarEmissor = () => new Promise((resolve) => { setTimeout(resolve, 1700); });

const sql = async (t, consulta, replacements = {}) => (await sequelize.query(consulta, { replacements, transaction: t }))[0];
const envios = (t, invoiceId, operation) => sql(t, "SELECT * FROM integration.dispatches WHERE aggregate_type = 'InvoiceRequest' AND aggregate_id = :id AND (CAST(:op AS text) IS NULL OR operation = :op) ORDER BY created_at, id", { id: invoiceId, op: operation || null });
const nota = (t, id) => InvoiceRequest.findByPk(id, { transaction: t });
const documento = (t, invoiceId) => TaxDocument.findOne({ where: { invoiceRequestId: invoiceId }, transaction: t });

/** Injeta a falha na connection de NFS-e da empresa (config.sandbox_fault): TIMEOUT_AFTER_SEND ou HTTP_503; `null` limpa. */
async function falha(t, tipo) {
  const conexao = await ensureFiscalConnection(ctxDe(), t);
  await sequelize.query('UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb) WHERE id = :id', { replacements: { id: conexao.id, cfg: JSON.stringify(tipo ? { sandbox_fault: tipo } : {}) }, transaction: t });
  return conexao;
}

module.exports = { sequelize, withRollbackTenantTransaction, uniqueSuffix, carregar, ctxDe, a, pedir, consultar, cancelar, esperarEmissor, sql, envios, nota, documento, falha, resetSandbox, sandboxStats, nfseService, get tenant() { return tenant; } };
