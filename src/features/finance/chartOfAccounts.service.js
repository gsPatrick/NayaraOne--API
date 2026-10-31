'use strict';

const { ChartOfAccount, ChartOfAccountVersion, FinancialEntry } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// M4-01 — Plano de Contas.
//
// Distinção deliberada em relação ao que já existia: finance.cost_centers e
// finance.result_centers são dimensões GERENCIAIS (onde o dinheiro foi gasto / a que resultado
// pertence). O plano de contas é a classificação CONTÁBIL (natureza patrimonial/de resultado),
// hierárquica, e é o que permite fechar um balancete. As três dimensões coexistem no mesmo
// lançamento e são independentes entre si.
//
// Imutabilidade (FIN-003/FIN-010): conta NUNCA é apagada quando tem lançamento vinculado —
// desativa-se (is_active=false). Isso preserva a legibilidade histórica do ledger: um
// lançamento de 2024 continua apontando para a conta que ele de fato usou.

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

async function getAccount(id, transaction, options = {}) {
  const account = await ChartOfAccount.findByPk(id, { transaction, lock: options.lock && transaction ? transaction.LOCK.UPDATE : undefined });
  if (!account) throw AppError.notFound('Conta do plano de contas não encontrada.', 'FINANCE_CHART_ACCOUNT_NOT_FOUND');
  return account;
}

/**
 * assertAccountUsableForEntry — helper consumido por financialEntries.service.js quando o
 * lançamento informa `chartOfAccountId`: a conta precisa existir (dentro do RLS da empresa
 * atual, ou seja, ser da própria empresa) e estar ativa.
 */
async function assertAccountUsableForEntry(chartOfAccountId, companyId, transaction) {
  if (!chartOfAccountId) return null;
  const account = await ChartOfAccount.findByPk(chartOfAccountId, { transaction });
  if (!account || (companyId && account.companyId !== companyId)) {
    throw AppError.badRequest(
      'A conta contábil informada não existe no plano de contas desta empresa.',
      'FINANCE_CHART_ACCOUNT_NOT_FOUND'
    );
  }
  if (!account.isActive) {
    throw AppError.conflict(
      `A conta contábil "${account.code} — ${account.name}" está inativa e não aceita novos lançamentos.`,
      'FINANCE_CHART_ACCOUNT_INACTIVE'
    );
  }
  return account;
}

// --- §4 Plano de contas versionado (Frente 3) ------------------------------------------------
//
// Cada criação/alteração/desativação de conta grava uma VERSÃO append-only em
// finance.chart_of_account_versions (trigger no banco: nunca apaga; só encerra a vigência da
// versão aberta). O lançamento grava a versão vigente na data do fato, então renomear,
// reclassificar ou desativar uma conta não reescreve a classificação de lançamentos passados.

function snapshotOf(account) {
  return {
    code: account.code,
    name: account.name,
    accountType: account.accountType,
    parentAccountId: account.parentAccountId || null,
    isActive: Boolean(account.isActive),
  };
}

async function recordAccountVersion(account, changeReason, actorUserId, transaction, effectiveFrom = new Date()) {
  const open = await ChartOfAccountVersion.findOne({
    where: { chartOfAccountId: account.id, effectiveUntil: null },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  const last = await ChartOfAccountVersion.findOne({
    where: { chartOfAccountId: account.id },
    order: [['versionNumber', 'DESC']],
    transaction,
  });
  if (open) {
    const snap = snapshotOf(account);
    const unchanged = Object.keys(snap).every((k) => String(open[k] ?? '') === String(snap[k] ?? ''));
    if (unchanged) return open;
    open.effectiveUntil = effectiveFrom;
    await open.save({ transaction });
  }
  return ChartOfAccountVersion.create(
    {
      groupId: account.groupId,
      companyId: account.companyId,
      chartOfAccountId: account.id,
      versionNumber: last ? last.versionNumber + 1 : 1,
      ...snapshotOf(account),
      changeReason: changeReason || null,
      effectiveFrom: open ? effectiveFrom : (last ? effectiveFrom : account.createdAt || effectiveFrom),
      effectiveUntil: null,
      createdBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listAccountVersions(chartOfAccountId, transaction) {
  await getAccount(chartOfAccountId, transaction);
  return ChartOfAccountVersion.findAll({ where: { chartOfAccountId }, order: [['versionNumber', 'ASC']], transaction });
}

/**
 * resolveAccountVersionForEntry — versão da conta vigente em `factDate`. A conta precisa ser da
 * empresa e estar ATIVA naquela data. Fato anterior à primeira versão usa a primeira versão
 * (a conta nunca teve outra classificação). Conta sem nenhuma versão (criada fora do serviço)
 * recebe a v1 aqui mesmo, a partir do estado atual.
 */
async function resolveAccountVersionForEntry(chartOfAccountId, companyId, factDate, transaction) {
  if (!chartOfAccountId) return null;
  const account = await ChartOfAccount.findByPk(chartOfAccountId, { transaction });
  if (!account || (companyId && account.companyId !== companyId)) {
    throw AppError.badRequest('A conta contábil informada não existe no plano de contas desta empresa.', 'FINANCE_CHART_ACCOUNT_NOT_FOUND');
  }
  // Caderno M4 §4: "contas analíticas e sintéticas". Conta com filhas ativas é SINTÉTICA
  // (agrupadora): só consolida nos relatórios e não recebe lançamento direto — o lançamento vai
  // para a conta analítica (folha).
  const activeChildren = await ChartOfAccount.count({ where: { parentAccountId: account.id, isActive: true }, transaction });
  if (activeChildren > 0) {
    throw AppError.badRequest(
      `A conta "${account.code} — ${account.name}" é sintética (tem ${activeChildren} subconta(s)); lance na conta analítica.`,
      'FINANCE_CHART_ACCOUNT_SYNTHETIC'
    );
  }
  const at = factDate ? new Date(factDate) : new Date();
  if (Number.isNaN(at.getTime())) {
    throw AppError.badRequest('Data do fato inválida.', 'FINANCE_ENTRY_VALIDATION');
  }
  const { Op } = require('sequelize'); // eslint-disable-line global-require
  let version = await ChartOfAccountVersion.findOne({
    where: {
      chartOfAccountId,
      effectiveFrom: { [Op.lte]: at },
      [Op.or]: [{ effectiveUntil: null }, { effectiveUntil: { [Op.gt]: at } }],
    },
    order: [['versionNumber', 'DESC']],
    transaction,
  });
  if (!version) {
    version = await ChartOfAccountVersion.findOne({ where: { chartOfAccountId }, order: [['versionNumber', 'ASC']], transaction });
  }
  if (!version) {
    version = await recordAccountVersion(account, 'Versão inicial (conta sem histórico).', null, transaction);
  }
  if (!version.isActive) {
    throw AppError.conflict(
      `A conta contábil "${version.code} — ${version.name}" estava inativa na data do fato e não aceita lançamentos.`,
      'FINANCE_CHART_ACCOUNT_INACTIVE'
    );
  }
  return version;
}

async function createAccount(payload, actorUserId, transaction) {
  const { groupId, companyId, code, name, accountType, parentAccountId } = payload;
  if (!groupId || !companyId || !code || !name || !accountType) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "code", "name" e "accountType" são obrigatórios.',
      'FINANCE_CHART_ACCOUNT_VALIDATION'
    );
  }
  const normalizedType = String(accountType).toUpperCase();
  if (!ACCOUNT_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(
      `O campo "accountType" deve ser um de: ${ACCOUNT_TYPES.join(', ')}.`,
      'FINANCE_CHART_ACCOUNT_VALIDATION'
    );
  }

  if (parentAccountId) {
    const parent = await getAccount(parentAccountId, transaction);
    if (parent.companyId !== companyId) {
      throw AppError.badRequest('A conta pai precisa pertencer à mesma empresa.', 'FINANCE_CHART_ACCOUNT_VALIDATION');
    }
    // Uma conta de despesa pendurada debaixo de uma conta de ativo produz um plano de contas
    // que não fecha em nenhum balancete — a natureza é herdada por definição na hierarquia.
    if (parent.accountType !== normalizedType) {
      throw AppError.badRequest(
        `A conta filha precisa ter o mesmo "accountType" da conta pai (pai é ${parent.accountType}).`,
        'FINANCE_CHART_ACCOUNT_TYPE_MISMATCH'
      );
    }
    if (!parent.isActive) {
      throw AppError.conflict('Não é possível criar conta filha sob uma conta inativa.', 'FINANCE_CHART_ACCOUNT_INACTIVE');
    }
  }

  let account;
  try {
    account = await ChartOfAccount.create(
      {
        groupId,
        companyId,
        code: String(code).trim(),
        name: String(name).trim(),
        accountType: normalizedType,
        parentAccountId: parentAccountId || null,
        isActive: true,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        `Já existe uma conta com o código "${code}" no plano de contas desta empresa.`,
        'FINANCE_CHART_ACCOUNT_DUPLICATE_CODE'
      );
    }
    throw err;
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.chart_of_account.create',
      entityType: 'ChartOfAccount',
      entityId: account.id,
      afterJson: account.toJSON(),
      reason: `Conta contábil "${account.code} — ${account.name}" (${normalizedType}) criada.`,
    },
    transaction
  );

  await recordAccountVersion(account, 'Versão inicial.', actorUserId, transaction);

  return account;
}

/**
 * listAccounts — lista plana por padrão. Filtros: `parentId` (filhas diretas de uma conta;
 * `parentId: 'ROOT'` devolve só as raízes), `accountType`, `isActive`. Com `asTree: true`,
 * devolve a hierarquia montada em memória (`children` em cada nó) — o plano de contas de uma
 * empresa é pequeno o bastante para isso ser mais barato do que uma recursive CTE.
 */
async function listAccounts(transaction, filters = {}) {
  const where = {};
  if (filters.accountType) where.accountType = String(filters.accountType).toUpperCase();
  if (filters.isActive !== undefined && filters.isActive !== null && filters.isActive !== '') {
    where.isActive = filters.isActive === true || filters.isActive === 'true';
  }
  if (filters.parentId !== undefined && filters.parentId !== null && filters.parentId !== '') {
    where.parentAccountId = filters.parentId === 'ROOT' ? null : filters.parentId;
  }

  const accounts = await ChartOfAccount.findAll({ where, order: [['code', 'ASC']], transaction });
  if (!filters.asTree) return accounts;

  const nodes = new Map();
  for (const account of accounts) {
    nodes.set(account.id, { ...account.toJSON(), children: [] });
  }
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentAccountId ? nodes.get(node.parentAccountId) : null;
    // Se o pai não está no resultado (filtrado de fora), o nó vira raiz da árvore devolvida —
    // preferível a sumir silenciosamente da listagem.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

async function updateAccount(id, payload, actorUserId, transaction) {
  const account = await getAccount(id, transaction, { lock: true });
  const beforeJson = account.toJSON();
  const { code, name, accountType, parentAccountId } = payload;

  if (accountType !== undefined) {
    const normalizedType = String(accountType).toUpperCase();
    if (!ACCOUNT_TYPES.includes(normalizedType)) {
      throw AppError.badRequest(`O campo "accountType" deve ser um de: ${ACCOUNT_TYPES.join(', ')}.`, 'FINANCE_CHART_ACCOUNT_VALIDATION');
    }
    // Trocar a natureza de uma conta que já tem lançamento reclassificaria retroativamente
    // dinheiro que já foi contabilizado — o mesmo tipo de reescrita de histórico que FIN-003
    // proíbe no ledger. Nesse caso a saída correta é criar uma conta nova e desativar esta.
    if (normalizedType !== account.accountType) {
      const usageCount = await FinancialEntry.count({ where: { chartOfAccountId: account.id }, transaction });
      if (usageCount > 0) {
        throw AppError.conflict(
          `Não é possível mudar a natureza contábil de uma conta que já tem ${usageCount} lançamento(s) vinculado(s) — crie uma conta nova e desative esta.`,
          'FINANCE_CHART_ACCOUNT_IN_USE'
        );
      }
    }
    account.accountType = normalizedType;
  }

  if (parentAccountId !== undefined) {
    if (parentAccountId === null) {
      account.parentAccountId = null;
    } else {
      if (parentAccountId === account.id) {
        throw AppError.badRequest('Uma conta não pode ser pai de si mesma.', 'FINANCE_CHART_ACCOUNT_CYCLE');
      }
      const parent = await getAccount(parentAccountId, transaction);
      // Ciclo na hierarquia (A -> B -> A) tornaria qualquer travessia da árvore infinita.
      let cursor = parent;
      const seen = new Set([account.id]);
      while (cursor) {
        if (seen.has(cursor.id)) {
          throw AppError.badRequest('A mudança de conta pai criaria um ciclo na hierarquia.', 'FINANCE_CHART_ACCOUNT_CYCLE');
        }
        seen.add(cursor.id);
        cursor = cursor.parentAccountId ? await getAccount(cursor.parentAccountId, transaction) : null;
      }
      if (parent.accountType !== account.accountType) {
        throw AppError.badRequest(
          `A conta filha precisa ter o mesmo "accountType" da conta pai (pai é ${parent.accountType}).`,
          'FINANCE_CHART_ACCOUNT_TYPE_MISMATCH'
        );
      }
      account.parentAccountId = parentAccountId;
    }
  }

  if (code !== undefined) account.code = String(code).trim();
  if (name !== undefined) account.name = String(name).trim();
  account.updatedBy = actorUserId || null;

  try {
    await account.save({ transaction });
    await recordAccountVersion(account, payload.changeReason || 'Conta alterada.', actorUserId, transaction);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        `Já existe uma conta com o código "${code}" no plano de contas desta empresa.`,
        'FINANCE_CHART_ACCOUNT_DUPLICATE_CODE'
      );
    }
    throw err;
  }

  await registrarAuditoria(
    {
      groupId: account.groupId,
      companyId: account.companyId,
      actorUserId,
      action: 'finance.chart_of_account.update',
      entityType: 'ChartOfAccount',
      entityId: account.id,
      beforeJson,
      afterJson: account.toJSON(),
      reason: `Conta contábil "${account.code}" atualizada.`,
    },
    transaction
  );

  return account;
}

/**
 * deactivateAccount — desativação lógica. NUNCA apaga: uma conta com lançamento vinculado é
 * parte da história do ledger. Contas filhas ativas também bloqueiam (desative de baixo pra
 * cima), senão sobraria uma filha ativa pendurada num pai inativo.
 */
async function deactivateAccount(id, actorUserId, transaction) {
  const account = await getAccount(id, transaction, { lock: true });
  if (!account.isActive) {
    throw AppError.conflict('Esta conta já está inativa.', 'FINANCE_CHART_ACCOUNT_ALREADY_INACTIVE');
  }
  const activeChildren = await ChartOfAccount.count({
    where: { parentAccountId: account.id, isActive: true },
    transaction,
  });
  if (activeChildren > 0) {
    throw AppError.conflict(
      `Esta conta tem ${activeChildren} conta(s) filha(s) ativa(s) — desative as filhas primeiro.`,
      'FINANCE_CHART_ACCOUNT_HAS_ACTIVE_CHILDREN'
    );
  }

  const beforeJson = account.toJSON();
  account.isActive = false;
  account.updatedBy = actorUserId || null;
  await account.save({ transaction });
  await recordAccountVersion(account, 'Conta desativada.', actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId: account.groupId,
      companyId: account.companyId,
      actorUserId,
      action: 'finance.chart_of_account.deactivate',
      entityType: 'ChartOfAccount',
      entityId: account.id,
      beforeJson,
      afterJson: account.toJSON(),
      reason: `Conta contábil "${account.code} — ${account.name}" desativada (nunca excluída: preserva o histórico do ledger).`,
    },
    transaction
  );

  return account;
}

module.exports = {
  createAccount,
  listAccounts,
  getAccount,
  updateAccount,
  deactivateAccount,
  assertAccountUsableForEntry,
  ACCOUNT_TYPES,
  recordAccountVersion,
  listAccountVersions,
  resolveAccountVersionForEntry,
};
