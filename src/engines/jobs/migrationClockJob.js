'use strict';

const { Group, Company, sequelize } = require('../../models');
const logger = require('../../utils/logger');
const readers = require('../../features/migration-v2/clock/clock.readers');
const { readNtp } = require('../../features/migration-v2/clock/ntp.reader');
const { recheckAndResume } = require('../../features/migration-v2/clock/clock.resume');

/**
 * migrationClockJob (M9-D908 §3.1) — registra o leitor do NTP no processo da API e, a cada minuto, empresa por empresa, repete a conferência dos relógios (no ritmo de
 * `migracao.relogio.reverificar_min`) enquanto houver execução da migração PAUSED por deriva ou deriva aberta na Torre. Ao medir dentro do limite, as execuções PAUSED voltam a
 * QUEUED e o migrationRunJob as retoma sozinho do último checkpoint. Desligar no processo: MIGRATION_CLOCK_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 60 * 1000;

async function runMigrationClockJob() {
  const total = { companies: 0, checked: 0, resumed: 0, errors: 0 };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      try {
         
        const one = await recheckAndResume({ groupId: group.id, companyId: company.id });
        if (one.checked) total.checked += 1;
        total.resumed += one.resumed.length;
      } catch (err) {
        total.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, 'migrationClockJob.company.failed');
      }
    }
  }
  if (total.checked || total.resumed || total.errors) logger.info(total, 'migrationClockJob.run');
  return total;
}

/** O NTP entra na validação de relógio só no processo da API (os testes e o laboratório offline não dependem da rede). */
function registerNtpReader() {
  return readers.register('NTP', readNtp);
}

function startMigrationClockJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  registerNtpReader();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runMigrationClockJob(); } catch (err) { logger.error({ err: err.message }, 'migrationClockJob.failed'); } finally { running = false; }
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runMigrationClockJob, startMigrationClockJob, registerNtpReader };
