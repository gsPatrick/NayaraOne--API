#!/usr/bin/env node
'use strict';
/**
 * Cria na homologação (LAB, DI-BI2-16) o usuário de teste do smoke da promoção do BI (etapa 12 da esteira): papel próprio com exatamente as
 * permissões de leitura que os painéis exigem, usuário de teste e vínculo na empresa A. Pela API pública, com o administrador de teste e o código do
 * autenticador dele (HOMO_ADMIN_MFA_CODE, vale ~30 s; criar papel, definir senha e vincular exigem MFA recente). A senha é aleatória e vai SÓ para o
 * arquivo de segredos (HOMO_BI_SMOKE_EMAIL / HOMO_BI_SMOKE_PASSWORD), antes de qualquer escrita; nada é impresso. Rodar de novo retoma (papel,
 * usuário e vínculo existentes são reaproveitados; a senha é redefinida).
 *
 * Uso: HOMO_SEGREDOS_ARQUIVO=... HOMO_ADMIN_EMAIL=... HOMO_ADMIN_COMPANY_ID=... HOMO_ADMIN_MFA_CODE=<6 dígitos> node scripts/homo/criarUsuarioSmokeBi.js
 */
const fs = require('fs');
const crypto = require('crypto');
const { Sessao, PararScript, lerBase } = require('./lib/cliente');
const { carregarSegredos, recusarSegredoNaLinhaDeComando } = require('./lib/segredosArquivo');

const EMAIL = 'bi-smoke@nayaraone.dev';
const PAPEL = 'BI — smoke da promoção (somente leitura)';
const PERMISSOES = ['analytics:read', 'analytics:read:tech', 'finance:read', 'crm:opportunities:read', 'legal:read', 'correspondent:read',
  'construction:read', 'inventory:read', 'marketing:attribution:read', 'crm:feedback:read'];
const lista = (r) => (Array.isArray(r.dados) ? r.dados : (r.dados && (r.dados.items || r.dados.rows)) || []);
const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;

function gravar(arquivo, senha) {
  const linhas = fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter((l) => !/^(export\s+)?HOMO_BI_SMOKE_(EMAIL|PASSWORD)\s*=/.test(l));
  while (linhas.length && linhas[linhas.length - 1] === '') linhas.pop();
  linhas.push(`HOMO_BI_SMOKE_EMAIL=${EMAIL}`, `HOMO_BI_SMOKE_PASSWORD=${senha}`, '');
  fs.writeFileSync(arquivo, linhas.join('\n'), { mode: 0o600 });
  fs.chmodSync(arquivo, 0o600);
}

async function main() {
  recusarSegredoNaLinhaDeComando(process.argv);
  const env = carregarSegredos(process.env);
  const base = lerBase(env);
  const admin = await new Sessao(base, 'administrador', env.HOMO_ADMIN_EMAIL, env.HOMO_ADMIN_PASSWORD, {
    codigoMfa: env.HOMO_ADMIN_MFA_CODE, segredoMfa: env.HOMO_ADMIN_MFA_SECRET, companyId: env.HOMO_ADMIN_COMPANY_ID,
  }).entrar();

  const catalogo = lista(await admin.chamar('GET', '/permissions'));
  const ids = PERMISSOES.map((c) => (catalogo.find((p) => p.code === c) || {}).id);
  const faltam = PERMISSOES.filter((_, i) => !ids[i]);
  if (faltam.length) throw new PararScript(`Permissões inexistentes no catálogo: ${faltam.join(', ')}`);

  let papel = lista(await admin.chamar('GET', '/roles')).find((r) => r.name === PAPEL);
  if (!papel) {
    const r = await admin.chamar('POST', '/roles', { name: PAPEL, description: 'Usuário de teste do smoke da promoção do BI para o LAB (homologação). Só leitura.', permissionIds: ids });
    if (r.status !== 201) throw new PararScript(`Papel não criado: ${resumo(r)}`);
    papel = r.dados;
  }

  const senha = `Smoke-${crypto.randomBytes(18).toString('base64url')}`;
  gravar(env.HOMO_SEGREDOS_ARQUIVO, senha);
  let usuario = lista(await admin.chamar('GET', '/users?limit=5000')).find((u) => String(u.email).toLowerCase() === EMAIL);
  if (usuario) {
    const r = await admin.chamar('PATCH', `/users/${usuario.id}/set-password`, { password: senha });
    if (r.status !== 200) throw new PararScript(`Senha não definida: ${resumo(r)}`);
  } else {
    const r = await admin.chamar('POST', '/users', { name: 'BI smoke da promoção (teste)', email: EMAIL, password: senha });
    if (r.status !== 201) throw new PararScript(`Usuário não criado: ${resumo(r)}`);
    usuario = r.dados;
  }
  const vinculos = lista(await admin.chamar('GET', `/memberships?userId=${usuario.id}`)).filter((m) => m.userId === usuario.id && m.companyId === admin.companyId);
  if (!vinculos.length) {
    const r = await admin.chamar('POST', '/memberships', { userId: usuario.id, roleId: papel.id });
    if (r.status !== 201) throw new PararScript(`Vínculo não criado: ${resumo(r)}`);
  }

  const smoke = await new Sessao(base, 'smoke do BI', EMAIL, senha, { companyId: env.HOMO_ADMIN_COMPANY_ID }).entrar();
  const paineis = {};
  for (const codigo of ['tech', 'command_center', 'health']) paineis[codigo] = (await smoke.chamar('GET', `/analytics/dashboards/${codigo}`)).status;
  console.log(JSON.stringify({ usuario: { id: usuario.id, email: EMAIL }, papel: { id: papel.id, nome: PAPEL, permissoes: PERMISSOES }, empresa: smoke.companyId, paineis }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof PararScript ? `PARADO: ${e.message}` : `ERRO: ${e.message}`);
  process.exit(e instanceof PararScript ? 2 : 1);
});
