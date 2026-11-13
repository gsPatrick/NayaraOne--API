'use strict';

// Retrato (snapshot) imutável do mês no momento da aprovação do fechamento, com hash canônico.

const {
  sequelize,
  PeriodClosureSnapshot,
  FinancialEntry,
} = require('../../../../models');
const { centsOf, moneyOf, sha256, canonicalJson } = require('./closing-hash');

async function buildClosingSnapshot(closure, preconditions, actorUserId, transaction) {
  const totals = await FinancialEntry.findAll({
    where: { companyId: closure.companyId, competenceMonth: closure.referenceMonth, parentEntryId: null },
    attributes: [
      'nature',
      'status',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      [sequelize.fn('SUM', sequelize.col('amount')), 'sum'],
    ],
    group: ['nature', 'status'],
    order: [['nature', 'ASC'], ['status', 'ASC']],
    raw: true,
    transaction,
  });
  const snapshotJson = {
    companyId: closure.companyId,
    referenceMonth: closure.referenceMonth,
    closedAt: new Date().toISOString(),
    requestedByUserId: closure.reviewRequestedByUserId || closure.updatedBy || null,
    approvedByUserId: actorUserId || null,
    totalsByNatureAndStatus: totals.map((row) => ({
      nature: row.nature,
      status: row.status,
      count: Number(row.count),
      sum: moneyOf(centsOf(row.sum)),
    })),
    thirdParty: preconditions.thirdParty,
    preconditions: preconditions.items.map((item) => ({ code: item.code, ok: item.ok, count: item.count, detail: item.detail })),
    checks: {
      thirdPartyCheckedAt: closure.thirdPartyCheckedAt ? closure.thirdPartyCheckedAt.toISOString() : null,
      thirdPartyCheckedByUserId: closure.thirdPartyCheckedByUserId,
      thirdPartyCheckNote: closure.thirdPartyCheckNote,
      thirdPartyFingerprint: preconditions.thirdParty.fingerprint,
      commissionsReviewedAt: closure.commissionsReviewedAt ? closure.commissionsReviewedAt.toISOString() : null,
      commissionsReviewedByUserId: closure.commissionsReviewedByUserId,
      commissionsReviewNote: closure.commissionsReviewNote,
      commissionsFingerprint: preconditions.commissionsFingerprint,
    },
  };
  const snapshotHash = sha256(canonicalJson(snapshotJson));
  return PeriodClosureSnapshot.create(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      periodClosureId: closure.id,
      referenceMonth: closure.referenceMonth,
      snapshotJson,
      snapshotHash,
      createdBy: actorUserId || null,
    },
    { transaction }
  );
}

function verifySnapshotIntegrity(snapshot) {
  return sha256(canonicalJson(snapshot.snapshotJson)) === snapshot.snapshotHash;
}

module.exports = { buildClosingSnapshot, verifySnapshotIntegrity };
