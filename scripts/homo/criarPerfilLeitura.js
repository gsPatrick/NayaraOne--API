#!/usr/bin/env node
'use strict';
/**
 * Cria na homologação um NOVO usuário de teste somente leitura na empresa A, com o MESMO papel do perfil de leitura original, para os
 * roteiros de aceite (o original deixou de aceitar a senha do arquivo; ele não é alterado). Pela API pública, com o administrador de teste
 * (o vínculo exige MFA recente, feito com o segredo TOTP do arquivo). A senha nova é aleatória e vai SÓ para o arquivo de segredos
 * (HOMO_SEGREDOS_ARQUIVO, fora do repositório, permissão 600), em HOMO_LEITURA_PASSWORD; nada de senha, token ou segredo é impresso.
 *
 * Uso: HOMO_SEGREDOS_ARQUIVO=... HOMO_ADMIN_EMAIL=... HOMO_ADMIN_COMPANY_ID=... HOMO_LEITURA_ORIGINAL_EMAIL=... HOMO_LEITURA_NOVO_EMAIL=...
 *      [HOMO_ADMIN_MFA_CODE=<código de 6 dígitos do autenticador do admin, vale 30 s>] node scripts/homo/criarPerfilLeitura.js
 * Retoma: se o usuário novo já existe sem vínculo, define a senha (MFA recente) e cria o vínculo.
 */
const fs = require('fs');
const crypto = require('crypto');
const { Sessao, PararScript, lerBase } = require('./lib/cliente');
const { carregarSegredos, recusarSegredoNaLinhaDeComando } = require('./lib/segredosArquivo');

const lista = (r) => (Array.isArray(r.dados) ? r.dados : (r.dados && (r.dados.items || r.dados.rows)) || []);

function gravarSenha(arquivo, email, senha) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  const copia = `${arquivo}.antes-perfil-leitura`;
  if (!fs.existsSync(copia)) fs.writeFileSync(copia, texto, { mode: 0o600 });
  const fora = /^(export\s+)?HOMO_LEITURA_(PASSWORD|EMAIL)\s*=/;
  const linhas = texto.split(/\r?\n/).filter((l) => !fora.test(l)).map((l) => (/^(export\s+)?HOMO_LEITURA_MFA_SECRET\s*=/.test(l)
    ? `# (segredo MFA do perfil de leitura original, que não é mais usado) ${l}` : l));
  while (linhas.length && linhas[linhas.length - 1] === '') linhas.pop();
  linhas.push(`HOMO_LEITURA_EMAIL=${email}`, `HOMO_LEITURA_PASSWORD=${senha}`, '');
  fs.writeFileSync(arquivo, linhas.join('\n'), { mode: 0o600 });
  fs.chmodSync(arquivo, 0o600);
}

async function main() {
  recusarSegredoNaLinhaDeComando(process.argv);
  const env = carregarSegredos(process.env);
  const arquivo = env.HOMO_SEGREDOS_ARQUIVO;
  const original = String(env.HOMO_LEITURA_ORIGINAL_EMAIL || '').toLowerCase();
  const novo = String(env.HOMO_LEITURA_NOVO_EMAIL || '').toLowerCase();
  if (!arquivo || !original || !novo) throw new PararScript('Informe HOMO_SEGREDOS_ARQUIVO, HOMO_LEITURA_ORIGINAL_EMAIL e HOMO_LEITURA_NOVO_EMAIL.');
  const admin = await new Sessao(lerBase(env), 'administrador', env.HOMO_ADMIN_EMAIL, env.HOMO_ADMIN_PASSWORD, {
    segredoMfa: env.HOMO_ADMIN_MFA_SECRET, codigoMfa: env.HOMO_ADMIN_MFA_CODE, companyId: env.HOMO_ADMIN_COMPANY_ID,
  }).entrar();

  const usuarios = lista(await admin.chamar('GET', '/users?limit=5000'));
  const orig = usuarios.find((u) => String(u.email).toLowerCase() === original);
  if (!orig) throw new PararScript(`O perfil de leitura original (${original}) não aparece em /users da empresa A.`);
  const vinculosDe = async (id) => lista(await admin.chamar('GET', `/memberships?userId=${id}`)).filter((m) => m.userId === id && m.companyId === admin.companyId);
  const vinculos = await vinculosDe(orig.id);
  if (vinculos.length !== 1 || !vinculos[0].roleId) throw new PararScript(`O perfil original tem ${vinculos.length} vínculo(s) na empresa A; esperado 1 com papel.`);
  const roleId = vinculos[0].roleId;

  // A senha vai para o arquivo ANTES de qualquer escrita na API: se algo parar no meio, ela não se perde (rodar de novo retoma).
  const senha = `Aceite-${crypto.randomBytes(18).toString('base64url')}`;
  gravarSenha(arquivo, novo, senha);
  let alvo = usuarios.find((u) => String(u.email).toLowerCase() === novo);
  let acao;
  if (alvo) {
    const jaTem = await vinculosDe(alvo.id);
    if (jaTem.some((m) => m.roleId !== roleId)) throw new PararScript(`${novo} já tem vínculo com outro papel na empresa A: nada foi alterado.`);
    const r = await admin.chamar('PATCH', `/users/${alvo.id}/set-password`, { password: senha });
    if (r.status !== 200) throw new PararScript(`Definir a senha de ${novo} foi recusado: HTTP ${r.status} ${r.erro ? r.erro.code : ''}`);
    acao = 'usuário já existia (criado na tentativa anterior, sem vínculo): senha definida';
  } else {
    const criado = await admin.chamar('POST', '/users', { name: 'ACEITE-M9 Perfil somente leitura (2)', email: novo, password: senha });
    if (criado.status !== 201) throw new PararScript(`Criação do usuário recusada: HTTP ${criado.status} ${criado.erro ? criado.erro.code : ''}`);
    alvo = criado.dados;
    acao = 'usuário criado';
  }
  if (!(await vinculosDe(alvo.id)).length) {
    const vinculo = await admin.chamar('POST', '/memberships', { userId: alvo.id, roleId });
    if (vinculo.status !== 201) throw new PararScript(`Usuário ${alvo.id} sem vínculo: HTTP ${vinculo.status} ${vinculo.erro ? vinculo.erro.code : ''}. Rode de novo (retoma daqui).`);
    acao += '; vínculo com o papel do perfil original criado';
  }

  const teste = await new Sessao(lerBase(env), 'somente leitura (novo)', novo, senha, { companyId: env.HOMO_ADMIN_COMPANY_ID }).entrar();
  console.log(JSON.stringify({ acao, usuario: { id: alvo.id, email: novo }, papel: roleId, papelDoOriginal: true, empresa: teste.companyId, loginOk: Boolean(teste.token), senhaGravadaEm: 'HOMO_LEITURA_PASSWORD do arquivo de segredos (cópia anterior: <arquivo>.antes-perfil-leitura)' }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof PararScript ? `PARADO: ${e.message}` : `ERRO: ${e.message}`);
  process.exit(e instanceof PararScript ? 2 : 1);
});
