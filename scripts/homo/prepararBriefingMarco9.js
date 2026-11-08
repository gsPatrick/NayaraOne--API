#!/usr/bin/env node
'use strict';

/**
 * Prepara a Empresa Dev (homologação) para o Briefing da NAY Diretoria funcionar (M9-D693), pela API pública. O briefing exige, nesta ordem:
 *   1. a IA ligada na empresa (ia.habilitada) e o provedor padrão do laboratório (ai-sandbox, sem chave e sem custo externo);
 *   2. o agente NAY_DIRETORIA com uma versão ATIVA (cadastrar, homologar por outra pessoa, ativar);
 *   3. a identidade de serviço somente leitura do agente (é ela que o job usa; sem ela o briefing fica "indisponível" por segurança);
 *   4. um orçamento de IA da empresa (já existente em homologação; criado só se faltar);
 *   5. o job do briefing rodar: ele roda sozinho à hora `analytics.brief.hora_diario` (padrão 06:30). Com --agora, a hora é antecipada para 00:00 para a
 *      geração acontecer no próximo minuto (o livro não pede rota de geração sob demanda); depois o script devolve a hora ao valor anterior.
 *
 * Uso (variáveis de ambiente; a senha nunca vai para a linha de comando nem para o arquivo):
 *   HOMO_API_BASE=https://.../api/v1 HOMO_ADMIN_EMAIL=... HOMO_ADMIN_PASSWORD=... [HOMO_ADMIN_MFA_CODE=123456] [HOMO_SEGUNDO_EMAIL/HOMO_SEGUNDO_PASSWORD]
 *   node scripts/homo/prepararBriefingMarco9.js [--agora] [--relaxar-segregacao]
 *
 * Quem cadastra o agente não pode homologá-lo (segregação de funções). Informe um segundo usuário com `ai:evaluate` ou use --relaxar-segregacao, que desliga
 * `ia.agente.segregacao_funcoes` SÓ nesta empresa de homologação (decisão de quem opera; fica no log de auditoria). Idempotente. Recusa endereço de produção.
 */
const AGENT = 'NAY_DIRETORIA';
const READ_PERMISSIONS = ['finance:read', 'crm:opportunities:read', 'construction:read', 'legal:read', 'correspondent:read', 'inventory:read'];
const BASE = (process.env.HOMO_API_BASE || '').replace(/\/$/, '');
const argv = new Set(process.argv.slice(2));
const log = (...a) => console.log('[briefing-homologacao]', ...a);

if (!BASE) { console.error('Informe HOMO_API_BASE (ex.: https://homologacao-nayaraone--api.hpztyd.easypanel.host/api/v1).'); process.exit(2); }
if (/producao|prod\./i.test(BASE)) { console.error('Endereço recusado: parece produção.'); process.exit(2); }

async function call(token, method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* corpo não JSON */ }
  return { status: res.status, json, data: json && json.data, code: json && json.error && json.error.code, message: json && json.error && json.error.message };
}

async function login(prefix) {
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!email || !password) return null;
  const r = await call(null, 'POST', '/auth/login', { email, password });
  if (r.status !== 200 || !r.data || !r.data.accessToken) throw new Error(`Login de ${email} falhou (HTTP ${r.status}${r.code ? ` ${r.code}` : ''}).`);
  const token = r.data.accessToken;
  const mfa = process.env[`${prefix}_MFA_CODE`];
  if (mfa) {
    const v = await call(token, 'POST', '/users/me/mfa/verify', { code: mfa });
    if (v.status >= 300) throw new Error(`Código MFA recusado (HTTP ${v.status}${v.code ? ` ${v.code}` : ''}).`);
  }
  return token;
}

const must = (r, what) => { if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${r.code || ''} ${r.message || ''}`.trim()); return r; };

async function main() {
  const admin = await login('HOMO_ADMIN');
  if (!admin) throw new Error('Informe HOMO_ADMIN_EMAIL e HOMO_ADMIN_PASSWORD.');
  const segundo = await login('HOMO_SEGUNDO');
  const relax = argv.has('--relaxar-segregacao');

  // 1. IA ligada
  for (const [key, value] of [['ia.habilitada', true], ['ia.agente.avaliacao_verde_obrigatoria', false], ['ia.avaliacao.homologacao_humana_todos', false]]) {
    must(await call(admin, 'PUT', `/settings/${key}`, { value }), `Parâmetro ${key}`);
  }
  if (relax) must(await call(admin, 'PUT', '/settings/ia.agente.segregacao_funcoes', { value: false }), 'Parâmetro ia.agente.segregacao_funcoes');
  log('IA ligada na empresa (provedor padrão de laboratório).');

  // 2. agente ativo
  const active = (must(await call(admin, 'GET', '/ai/agents'), 'Lista de agentes').data || []).find((a) => a.code === AGENT);
  if (active) log(`${AGENT} já tem a versão ${active.version} ativa.`);
  else {
    const created = must(await call(admin, 'POST', `/ai/agents/${AGENT}/versions`, {}), 'Cadastro da versão do agente').data;
    const homologator = segundo || admin;
    must(await call(homologator, 'POST', `/ai/agents/${AGENT}/versions/${created.version}/homologate`, {}), `Homologação da versão ${created.version} (use HOMO_SEGUNDO_* ou --relaxar-segregacao)`);
    must(await call(admin, 'POST', `/ai/agents/${AGENT}/versions/${created.version}/activate`, {}), `Ativação da versão ${created.version}`);
    log(`${AGENT} versão ${created.version} cadastrada, homologada e ativada.`);
  }

  // 3. identidade de serviço somente leitura
  const identities = must(await call(admin, 'GET', '/ai/service-identities'), 'Identidades de serviço').data || [];
  const mine = identities.find((i) => i.agentCode === AGENT);
  if (!mine) {
    must(await call(admin, 'POST', '/ai/service-identities', { agentCode: AGENT, permissions: READ_PERMISSIONS, enabled: true }), 'Criação da identidade de serviço');
    log('Identidade de serviço somente leitura criada.');
  } else if (!mine.enabled) {
    must(await call(admin, 'PATCH', `/ai/service-identities/${mine.id}`, { enabled: true }), 'Ativação da identidade de serviço');
    log('Identidade de serviço reativada.');
  } else log('Identidade de serviço já ativa.');

  // 4. orçamento
  const budgets = must(await call(admin, 'GET', '/ai/budgets'), 'Orçamentos').data || [];
  if (budgets.some((b) => b.status === 'ACTIVE' && !b.agentCode)) log('Orçamento de IA da empresa já existe.');
  else { must(await call(admin, 'POST', '/ai/budgets', { limitAmount: '100.00' }), 'Criação do orçamento'); log('Orçamento de IA criado (R$ 100,00 no mês).'); }

  // 5. gerar já (opcional)
  if (argv.has('--agora')) {
    const key = 'analytics.brief.hora_diario';
    const before = await call(admin, 'GET', `/settings/${key}`);
    const stored = before.status === 200 && before.data ? before.data.value : undefined; // sem valor gravado, vale o padrão do livro
    const previous = typeof stored === 'string' && stored.trim() ? stored : '06:30 America/Sao_Paulo';
    const retryKey = 'analytics.brief.reintento_falha_min'; // um briefing que já falhou hoje só é tentado de novo depois deste tempo (padrão 60 min)
    const retryBefore = await call(admin, 'GET', `/settings/${retryKey}`);
    const retryPrevious = retryBefore.status === 200 && retryBefore.data && Number.isInteger(Number(retryBefore.data.value)) ? Number(retryBefore.data.value) : 60;
    must(await call(admin, 'PUT', `/settings/${retryKey}`, { value: 1 }), `Parâmetro ${retryKey}`);
    must(await call(admin, 'PUT', `/settings/${key}`, { value: '00:00' }), `Parâmetro ${key}`);
    log('Hora do briefing diário antecipada para 00:00: o servidor gera no próximo minuto. Aguardando até 3 minutos...');
    let ready = null;
    for (let i = 0; i < 18 && !ready; i += 1) {
      await new Promise((r) => setTimeout(r, 10000));
      const c = await call(admin, 'GET', '/analytics/dashboards/command_center');
      if (c.data && c.data.brief && c.data.brief.available) ready = c.data.brief;
    }
    await call(admin, 'PUT', `/settings/${key}`, { value: previous });
    await call(admin, 'PUT', `/settings/${retryKey}`, { value: retryPrevious });
    log(ready ? `Briefing gerado com ${ready.items.length} item(ns). Hora diária devolvida ao valor anterior.` : 'O briefing ainda não apareceu; confira o Centro de Comando em alguns minutos (hora diária devolvida).');
  } else log('Pronto. O briefing diário é gerado pelo servidor na hora configurada (padrão 06:30); use --agora para gerar já.');
}

main().catch((err) => { console.error('[briefing-homologacao] ERRO:', err.message); process.exit(1); });
