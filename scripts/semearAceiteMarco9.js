#!/usr/bin/env node
'use strict';
/**
 * Semeia, pela API pública (nunca SQL), os registros fictícios e confere os perfis do aceite do Marco 9.
 * Idempotente: tudo leva o prefixo "ACEITE-M9"; rodar de novo encontra o que já existe e não duplica.
 *
 * Variáveis de ambiente (PERFIL = ADMIN, LEITURA ou OUTRA_EMPRESA):
 *   HOMO_API_BASE                 padrão http://127.0.0.1:4001/api/v1 (recusa endereço com "producao" ou "prod.")
 *   HOMO_ADMIN_EMAIL / HOMO_ADMIN_PASSWORD      administrador da empresa A (obrigatórios)
 *   HOMO_LEITURA_EMAIL / HOMO_LEITURA_PASSWORD  perfil somente leitura da empresa A (opcional)
 *   HOMO_OUTRA_EMPRESA_EMAIL / HOMO_OUTRA_EMPRESA_PASSWORD   usuário de outra empresa (opcional)
 *   HOMO_<PERFIL>_COMPANY_ID      opcional: empresa em que o perfil entra (vai como companyId no POST /auth/login). Use
 *                                 HOMO_OUTRA_EMPRESA_COMPANY_ID para um usuário com vínculo nas duas empresas do MESMO grupo
 *                                 entrar na outra empresa; o script confere que a API entrou mesmo nela.
 *   HOMO_<PERFIL>_MFA_CODE        opcional: código do aplicativo autenticador, usado só se a API pedir MFA recente.
 *   HOMO_<PERFIL>_MFA_SECRET      opcional: segredo TOTP do usuário de TESTE; o código é gerado na hora em que a API pede
 *                                 MFA recente (POST /users/me/mfa/verify). MFA nunca é contornado: é o mesmo código que o
 *                                 aplicativo mostraria. Segredo e código nunca são impressos nem gravados.
 *   HOMO_SEGREDOS_ARQUIVO         recomendado: arquivo HOMO_NOME=valor FORA de qualquer repositório e com chmod 600, com as senhas
 *                                 e os segredos TOTP (HOMO_*_PASSWORD, HOMO_*_MFA_SECRET). Assim nenhum segredo vai para a linha de
 *                                 comando nem para o histórico do shell. O que vier do ambiente vale primeiro.
 *   HOMO_SAIDA_JSON               opcional: caminho de um arquivo JSON com as conferências (data/hora, rota, status HTTP,
 *                                 código de erro). Sem senha, token, segredo nem código MFA.
 * Saída: 0 = tudo conferido; 1 = alguma conferência falhou; 2 = parada de segurança ou configuração.
 */
const fs = require('fs');
const { Sessao, PararScript, lerBase } = require('./homo/lib/cliente');
const { carregarSegredos } = require('./homo/lib/segredos');
const { Relato } = require('./homo/lib/relato');
const optOut = require('./homo/cenarios/optOutCampanha');
const automacao = require('./homo/cenarios/automacao');
const isolamento = require('./homo/cenarios/isolamento');
const trilha = require('./homo/cenarios/trilha');

async function abrirSessao(base, rotulo, prefixo, env) {
  const email = env[`${prefixo}_EMAIL`]; const senha = env[`${prefixo}_PASSWORD`];
  if (!email || !senha) return null;
  return new Sessao(base, rotulo, email, senha, {
    codigoMfa: env[`${prefixo}_MFA_CODE`], segredoMfa: env[`${prefixo}_MFA_SECRET`], companyId: env[`${prefixo}_COMPANY_ID`],
  }).entrar();
}

function gravarSaida(caminho, base, ctx, rel, inicio) {
  if (!caminho) return;
  const perfil = (s) => (s ? { email: s.email, groupId: s.groupId, companyId: s.companyId } : null);
  const dados = {
    roteiro: 'semearAceiteMarco9', base, inicio, fim: new Date().toISOString(),
    perfis: { admin: perfil(ctx.admin), leitura: perfil(ctx.leitura), outra: perfil(ctx.outra) },
    ids: ctx.ids, ...rel.paraJson(),
  };
  fs.writeFileSync(caminho, `${JSON.stringify(dados, null, 2)}\n`);
  console.log(`\nConferências gravadas em ${caminho}`);
}

async function principal() {
  const env = carregarSegredos(process.env); // senhas e segredos TOTP vêm de um arquivo fora do repositório, nunca da linha de comando
  const base = lerBase(env);
  const inicio = new Date().toISOString();
  if (!env.HOMO_ADMIN_EMAIL || !env.HOMO_ADMIN_PASSWORD) throw new PararScript('Informe HOMO_ADMIN_EMAIL e HOMO_ADMIN_PASSWORD (administrador da empresa A).');
  const rel = new Relato();
  console.log(`Aceite do Marco 9: semeando e conferindo em ${base} (${inicio})`);
  const ctx = {
    rel, ids: {},
    admin: await abrirSessao(base, 'administrador', 'HOMO_ADMIN', env),
    leitura: await abrirSessao(base, 'somente leitura', 'HOMO_LEITURA', env),
    outra: await abrirSessao(base, 'outra empresa', 'HOMO_OUTRA_EMPRESA', env),
  };
  if (ctx.outra && ctx.outra.companyId && ctx.admin.companyId && ctx.outra.companyId === ctx.admin.companyId) {
    throw new PararScript('O usuário "outra empresa" entrou na MESMA empresa do administrador; o teste de isolamento não valeria. Informe outro usuário ou HOMO_OUTRA_EMPRESA_COMPANY_ID.');
  }
  if (ctx.outra) {
    const mesmoGrupo = ctx.outra.groupId && ctx.outra.groupId === ctx.admin.groupId;
    rel.aviso(`Outra empresa: ${ctx.outra.companyId} (${mesmoGrupo ? 'MESMO grupo da empresa A' : 'grupo diferente da empresa A'}).`);
  }
  if (!ctx.leitura) rel.aviso('Sem perfil somente leitura (HOMO_LEITURA_*): o cenário (c) não confere as escritas recusadas.');
  if (!ctx.outra) rel.aviso('Sem usuário de outra empresa (HOMO_OUTRA_EMPRESA_*): o cenário (c) não confere o isolamento entre empresas.');

  try {
    // A automação vem primeiro: ela fica ativa só o tempo da demonstração e, se os contatos do cenário (a) já existissem, o gatilho (contato novo) agiria sobre eles também.
    await automacao.executar(ctx);
    await optOut.preparar(ctx);
    await optOut.conferir(ctx);
    await isolamento.executar(ctx);
    await trilha.executar(ctx);
  } finally {
    rel.imprimirQuadro();
    gravarSaida(env.HOMO_SAIDA_JSON, base, ctx, rel, inicio);
  }
  return rel.falhas === 0 ? 0 : 1;
}

principal().then((codigo) => { process.exitCode = codigo; }).catch((erro) => {
  if (erro instanceof PararScript) { console.error(`\nPARADO: ${erro.message}`); process.exitCode = erro.codigoSaida; return; }
  console.error(`\nERRO: ${erro && erro.message ? erro.message : erro}`);
  process.exitCode = 1;
});
