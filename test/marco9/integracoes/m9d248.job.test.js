'use strict';

// M9-D248 — job diário de auditoria de dependências (Postgres real; roda em banco descartável porque o job grava com commit).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { runDependencyAuditJob } = require('../../../src/engines/jobs/dependencyAuditJob');
const { auditReport, excecao } = require('../_helpers/depauditFixtures');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
  // O papel do usuário semente não traz integration:manage; a permissão entra no banco descartável para haver quem receba o aviso.
  await withTenantTransaction(tenant, (t) => sequelize.query(
    `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
     SELECT gen_random_uuid(), m.role_id, p.id, now(), now()
       FROM core.user_memberships m CROSS JOIN core.permissions p
      WHERE m.company_id = :c AND m.user_id = :u AND p.code = 'integration:manage'
        AND NOT EXISTS (SELECT 1 FROM core.role_permissions x WHERE x.role_id = m.role_id AND x.permission_id = p.id)`,
    { replacements: { c: tenant.companyId, u: tenant.userId }, transaction: t },
  ));
});
after(async () => { await sequelize.close(); });

const ghsa = () => `GHSA-${[0, 1, 2].map(() => Math.random().toString(36).slice(2, 6).padEnd(4, '0')).join('-')}`;
const SEM_DEP = { dependencies: {} };
const consulta = (sql, replacements) => withTenantTransaction(tenant, async (t) => (await sequelize.query(sql, { replacements, transaction: t }))[0]);
const erros = (pkg) => consulta("SELECT severity, source, error_class, error_code, status, attempts, message FROM integration.integration_errors WHERE company_id = :c AND provider_code = :p", { c: tenant.companyId, p: pkg });
const avisos = (pkg) => consulta("SELECT count(*)::int AS n FROM core.notifications WHERE company_id = :c AND body LIKE :b AND title LIKE 'Vulnerabilidade%'", { c: tenant.companyId, b: `${pkg}:%` });
const hoje = () => new Date().toISOString().slice(0, 10);
const emDias = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('audit_job_diario_gera_erro_e_alerta: aviso novo vira SDK_VULNERABILITY com a gravidade do aviso e notifica quem gerencia integrações, uma vez', async () => {
  const s = uniqueSuffix().toLowerCase();
  const alto = `qa-m9-alto-${s}`; const critico = `qa-m9-crit-${s}`; const liberado = `qa-m9-lib-${s}`; const moderado = `qa-m9-mod-${s}`;
  const idLiberado = ghsa();
  const report = auditReport([
    { pkg: alto, severity: 'high', ghsa: ghsa(), title: 'Execução remota' }, { pkg: critico, severity: 'critical', ghsa: ghsa() },
    { pkg: liberado, severity: 'high', ghsa: idLiberado }, { pkg: moderado, severity: 'moderate', ghsa: ghsa() },
  ]);
  const opts = { force: true, runner: async () => report, packageJson: SEM_DEP, exceptions: [excecao({ id: idLiberado, package: liberado, grantedAt: hoje(), expiresAt: emDias(30) })] };

  const r1 = await runDependencyAuditJob(opts);
  assert.equal(r1.ran, true);
  assert.equal(r1.errors, 0);
  const [e] = await erros(alto);
  assert.deepEqual([e.severity, e.source, e.error_class, e.error_code, e.status, e.attempts], ['HIGH', 'CONTRACT', 'SECURITY', 'SDK_VULNERABILITY', 'OPEN', 1]);
  assert.match(e.message, /Vulnerabilidade high em .*Execução remota/);
  assert.equal((await erros(critico))[0].severity, 'CRITICAL', 'a gravidade vem do aviso');
  assert.equal((await erros(liberado)).length, 0, 'aviso com exceção válida não gera erro');
  assert.equal((await erros(moderado)).length, 0, 'moderate não gera erro');
  const alertas1 = (await avisos(alto))[0].n;
  assert.ok(alertas1 >= 1, 'quem tem integration:manage recebe o aviso');

  const r2 = await runDependencyAuditJob(opts);
  assert.equal(r2.alerted, 0, 'o mesmo aviso reaparecendo não alerta de novo');
  const depois = await erros(alto);
  assert.equal(depois.length, 1, 'continua um único erro por aviso');
  assert.equal(depois[0].attempts, 2);
  assert.equal((await avisos(alto))[0].n, alertas1);

  // Exceção vencida: o aviso volta a gerar erro.
  const r3 = await runDependencyAuditJob({ ...opts, exceptions: [excecao({ id: idLiberado, package: liberado, grantedAt: emDias(-40), expiresAt: emDias(-10) })] });
  assert.ok(r3.blocking >= 1);
  assert.equal((await erros(liberado)).length, 1, 'exceção vencida volta a bloquear');
});

test('audit_job_diario_roda_uma_vez_por_dia_a_partir_da_hora_configurada_e_relata_sdk_sem_versao_exata', async () => {
  let chamadas = 0;
  const runner = async () => { chamadas += 1; return auditReport([]); };
  const dia = '2031-03-15';
  const antes = await runDependencyAuditJob({ now: new Date(`${dia}T05:00:00Z`), runner, packageJson: SEM_DEP, exceptions: [] }); // 02:00 em São Paulo
  assert.equal(antes.ran, false); assert.equal(chamadas, 0, 'antes da hora configurada (padrão 3) não roda');
  const rodou = await runDependencyAuditJob({ now: new Date(`${dia}T07:00:00Z`), runner, packageJson: SEM_DEP, exceptions: [] }); // 04:00
  assert.equal(rodou.ran, true); assert.equal(chamadas, 1);
  const repetiu = await runDependencyAuditJob({ now: new Date(`${dia}T20:00:00Z`), runner, packageJson: SEM_DEP, exceptions: [] });
  assert.equal(repetiu.ran, false); assert.equal(chamadas, 1, 'no mesmo dia não roda de novo');
  const outroDia = await runDependencyAuditJob({ now: new Date('2031-03-16T07:00:00Z'), runner, packageJson: SEM_DEP, exceptions: [] });
  assert.equal(outroDia.ran, true);

  await runDependencyAuditJob({ force: true, runner, exceptions: [], packageJson: { dependencies: { twilio: '^5.0.0' } } });
  const [pin] = await erros('twilio');
  assert.deepEqual([pin.error_code, pin.source, pin.error_class], ['SDK_NOT_PINNED', 'CONTRACT', 'VALIDATION']);
});
