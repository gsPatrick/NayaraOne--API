'use strict';

/**
 * M9-D608 (3.1) — comando operacional `node scripts/analytics/rebuildReadModel.js --model=<nome> --company=<id|all> --user=<id|email> [--motivo=<texto>]`.
 * Sem rota HTTP (o livro não pede). Quem roda precisa de uma identidade com a permissão analytics:rebuild na empresa (`--user`), e o
 * parâmetro analytics.rebuild.habilitado da empresa precisa estar ligado (padrão: ligado em LAB, desligado em produção).
 * Este arquivo só resolve identidade, empresas e permissões e imprime o resultado; a regra de negócio está em
 * src/features/analytics/read-models/rebuild.service.js. Fica em scripts/ porque o BI não importa serviço de outra área (BI-001).
 */
const { sequelize, Group, Company, User } = require('../../src/models');
const { getEffectiveAccess } = require('../../src/features/memberships/effectivePermissions.service');
const { rebuildReadModel } = require('../../src/features/analytics/read-models/rebuild.service');

const USAGE = 'Uso: node scripts/analytics/rebuildReadModel.js --model=<rm_nome> --company=<id|all> --user=<id|email> [--motivo=<texto>]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return { model: out.model, company: out.company, user: out.user, reason: (out.motivo || '').trim() || null };
}

async function findUser(ref) {
  return User.findOne({ where: UUID.test(ref) ? { id: ref } : { email: ref.toLowerCase() } });
}

/** Empresas-alvo com o grupo de cada uma: uma (--company=<id>) ou todas (--company=all). */
async function targetCompanies(company) {
  const targets = [];
  for (const group of await Group.findAll()) {
    const list = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const c of list) if (company === 'all' || c.id === company) targets.push({ groupId: group.id, companyId: c.id });
  }
  return targets;
}

async function permissionsOf(user, target) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: target.groupId, c: target.companyId }, transaction });
    return (await getEffectiveAccess(user.id, target.companyId, transaction)).permissions;
  });
}

function describe(r) {
  return `OK ${r.readModel} empresa ${r.companyId}: ${r.before.rows} -> ${r.after.rows} linhas; hash antes ${r.before.hash}; hash depois ${r.after.hash}; `
    + `acrescentadas ${r.added}, removidas ${r.removed}, alteradas ${r.changed}; reaplicados ${r.reapplied}; snapshots revisados ${r.snapshotsRevised}; ${r.durationMs} ms`;
}

/** Executa o comando. Devolve o código de saída (0 ok, 1 falha em alguma empresa, 2 uso incorreto). */
async function runCli(argv, { out = console.log, err = console.error } = {}) {
  const args = parseArgs(argv);
  if (!args.model || !args.company || !args.user || (args.company !== 'all' && !UUID.test(args.company))) {
    err(USAGE);
    return 2;
  }
  const user = await findUser(args.user);
  if (!user) {
    err('Usuário não encontrado.');
    return 1;
  }
  const targets = await targetCompanies(args.company);
  if (!targets.length) {
    err('Empresa não encontrada.');
    return 1;
  }
  let failed = 0;
  for (const target of targets) {
    try {
      const permissions = await permissionsOf(user, target);
      out(describe(await rebuildReadModel({ ...target, groupId: target.groupId, actorUserId: user.id, permissions, reason: args.reason }, { model: args.model, companyId: target.companyId })));
    } catch (e) {
      failed += 1;
      err(`ERRO ${e.code || 'ANALYTICS_REBUILD_FAILED'} (empresa ${target.companyId}): ${e.message}`);
    }
  }
  return failed ? 1 : 0;
}

module.exports = { runCli, parseArgs };
