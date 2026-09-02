'use strict';

const { Op } = require('sequelize');
const { AuditLog } = require('../../models');

// DECISÃO DE ENGENHARIA: audit.audit_log é escrita por praticamente toda feature do sistema
// (registrarAuditoria — ver auditLog.service.js) mas nunca teve uma rota de leitura própria.
// O comentário de auditLog.service.js já previa isso: "o que aparece pra quem for ler a
// trilha de auditoria, ex.: na tela 'Atividade' do front". Esta é essa tela/feature.
//
// audit_log é append-only por design ("nunca UPDATE/DELETE por usuário comum" — ver
// AuditLog.js) — por isso esta feature é SOMENTE LEITURA: listar e detalhar. Não existe
// endpoint de "reverter" genérico aqui — isso seria inseguro (contornaria os gates de máquina
// de estado do Contract e a imutabilidade do ledger financeiro, os dois já garantidos nas
// próprias features de domínio). Reverter uma ação é responsabilidade do domínio dono do
// registro (ex.: POST /finance/entries/:id/reverse, POST /legal/contracts/:id/transition) — a
// tela de Atividades apenas oferece atalhos para essas rotas já existentes, quando aplicável
// ao entityType do registro.
async function listAuditLog(transaction, filters = {}) {
  const where = {};
  if (filters.userId) where.userId = filters.userId;
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.action) where.action = filters.action;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.dateFrom || filters.dateTo) {
    where.occurredAt = {};
    if (filters.dateFrom) where.occurredAt[Op.gte] = new Date(filters.dateFrom);
    if (filters.dateTo) where.occurredAt[Op.lte] = new Date(filters.dateTo);
  }

  return AuditLog.findAll({
    where,
    order: [['occurred_at', 'DESC']],
    limit: 1000, // teto de segurança — trilha de auditoria pode crescer sem limite prático
    transaction,
  });
}

async function getAuditLogEntry(id, transaction) {
  const AppError = require('../../utils/AppError');
  const entry = await AuditLog.findByPk(id, { transaction });
  if (!entry) throw AppError.notFound('Registro de auditoria não encontrado.', 'AUDIT_LOG_NOT_FOUND');
  return entry;
}

module.exports = { listAuditLog, getAuditLogEntry };
