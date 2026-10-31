'use strict';

const content = require('../../content');
require('../../index'); // a fachada do Marketing registra a porta de agendamento dos jobs (M9-D410) e o tratador de conta comprometida (M9-D433): o ensaio usa o sistema como ele sobe
const { upsertSetting } = require('../../../settings/settings.service');
const { query } = require('./drill.env');
const { cloneScheduled } = require('./drill.clone');

/**
 * M9-D442 — dados do ensaio, criados pelos serviços de verdade (conteúdo institucional escrito à mão -> pipeline -> aprovação por outra pessoa -> agendamento), de modo que o
 * worker enfrenta exatamente o que enfrentaria em produção. Tudo dentro da transação descartável do ensaio.
 */
const MIN = 60000;

/** Cria `count` publicações aprovadas e agendadas no `channel` (uma por item: um job ativo por versão e canal). Devolve { jobs, now } com `now` = 1 min depois do horário. */
async function scheduledJobs(t, env, channel, count = 1) {
  const when = new Date(Date.now() + 120 * MIN);
  const titleOf = (i) => `Failure drill ${channel} ${i + 1}`;
  const created = await content.service.createAndRun({ tenant: env.tenant, actor: env.tenant.userId, input: { type: 'INSTITUTIONAL', title: titleOf(0), texto: 'Somos uma imobiliária de Salvador.' } }, (fn) => fn(t));
  const itemId = created.content.id;
  await content.service.approve({ tenant: env.tenant, actor: env.reviewer, itemId, input: {} }, t);
  const out = await content.service.schedule({ tenant: env.tenant, actor: env.reviewer, itemId, channels: [channel], when: when.toISOString() }, t);
  const first = out.jobs[0].id;
  // A 1ª publicação passa pelo pipeline de verdade; as outras são cópias dela (drill.clone), que não crescem com a máquina carregada.
  const row = (await query(t, 'SELECT content_version_id AS "versionId" FROM marketing.publication_jobs WHERE id = :first', { first }))[0];
  const copies = await cloneScheduled(t, { itemId, versionId: row.versionId, jobId: first }, count - 1, (i) => titleOf(i + 1));
  return { jobs: [first, ...copies], when, now: new Date(when.getTime() + MIN) };
}

const setParam = (t, env, key, value) => upsertSetting(key, value, env.tenant, env.tenant.userId, t);
const jobRow = async (t, id) => (await query(t, 'SELECT * FROM marketing.publication_jobs WHERE id = :id', { id }))[0];
const resultRows = (t, jobId) => query(t, 'SELECT outcome, attempt_no FROM marketing.publication_results WHERE job_id = :jobId ORDER BY occurred_at, created_at, attempt_no', { jobId });

module.exports = { scheduledJobs, setParam, jobRow, resultRows, MIN };
