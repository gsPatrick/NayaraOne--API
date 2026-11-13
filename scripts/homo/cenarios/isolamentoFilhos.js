'use strict';
/**
 * Cenário (c), parte 2: a outra empresa contra os FILHOS da pessoa da empresa A (endereço, documento, papel e arquivo), a lista
 * conferida por id e por empresa (não só pelo nome) e o mesmo CPF/CNPJ na outra empresa (DI-M9I-2: vira convite ao vínculo,
 * 409 sem id nem nome). Prepara pela API, de forma idempotente, a pessoa fictícia "ACEITE-M9 Pessoa com documento" na empresa A,
 * com CPF, endereço, papel e um documento com arquivo PDF (passa pelo antivírus da homologação). Nunca vincula: a outra empresa
 * só tenta ler e gravar.
 */
const { acharPessoa } = require('../lib/pessoas');

const CENARIO = '(c) isolamento';
const NOME_DOC = 'ACEITE-M9 Pessoa com documento (isolamento)';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
const barrado = (r) => [403, 404].includes(r.status);
const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;
const lista = (r) => (Array.isArray(r.dados) ? r.dados : []);

function cpfAleatorio() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (arr) => { const f = arr.length + 1; const r = (arr.reduce((acc, d, i) => acc + d * (f - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  n.push(dv(n)); n.push(dv(n));
  return n.join('');
}

/** Pessoa da empresa A com CPF, endereço, papel e documento com arquivo. Devolve null (com aviso) se não der para preparar. */
async function prepararPessoaComDocumento(ctx) {
  const admin = ctx.admin;
  let pessoa = await acharPessoa(admin, NOME_DOC);
  let cpf = pessoa ? pessoa.taxIdNormalized : null;
  if (!pessoa) {
    cpf = cpfAleatorio();
    const r = await admin.chamar('POST', '/people', { personType: 'PF', legalName: NOME_DOC, taxIdNormalized: cpf });
    if (r.status !== 201) { ctx.rel.aviso(`Não consegui criar "${NOME_DOC}" na empresa A: ${resumo(r)}.`); return null; }
    pessoa = r.dados;
  }
  // CPF mascarado (perfil sem permissão de ver dado restrito) não serve para a conferência do mesmo CPF.
  if (!/^\d{11}$/.test(String(cpf || ''))) cpf = null;
  const id = pessoa.id;
  if (!lista(await admin.chamar('GET', `/people/${id}/addresses`)).length) {
    await admin.chamar('POST', `/people/${id}/addresses`, { street: 'ACEITE-M9 Rua do isolamento', number: '1', city: 'São Paulo', state: 'SP' });
  }
  if (!lista(await admin.chamar('GET', `/people/${id}/roles`)).length) await admin.chamar('POST', `/people/${id}/roles`, { roleCode: 'CLIENTE' });
  let documento = lista(await admin.chamar('GET', `/people/${id}/documents`))[0] || null;
  if (!documento) {
    const arq = await admin.chamar('POST', '/files', { fileName: 'aceite-m9-isolamento.pdf', mimeType: 'application/pdf', contentBase64: PDF, category: 'people' });
    if (arq.status < 300 && arq.dados && arq.dados.id) {
      const d = await admin.chamar('POST', `/people/${id}/documents`, { documentType: 'RG', fileId: arq.dados.id });
      documento = d.status === 201 ? d.dados : null;
    } else {
      ctx.rel.aviso(`O arquivo fictício não foi aceito na empresa A (${resumo(arq)}); as conferências do arquivo ficam sem verificação.`);
    }
  }
  const contagem = {};
  for (const s of ['addresses', 'documents', 'roles']) contagem[s] = lista(await admin.chamar('GET', `/people/${id}/${s}`)).length;
  ctx.ids.pessoaDocumento = id;
  ctx.rel.item('Pessoa', NOME_DOC, 'preparada na empresa A (CPF, endereço, papel e documento)', id, 'Pessoas');
  return { id, cpf, nome: pessoa.legalName, fileId: documento ? documento.fileId : null, contagem };
}

async function executar(ctx) {
  const alvo = await prepararPessoaComDocumento(ctx);
  if (!alvo) {
    ctx.rel.conferir(CENARIO, 'outra empresa NÃO alcança endereço, documento, papel e arquivo da pessoa da empresa A', null, `A pessoa "${NOME_DOC}" não pôde ser preparada na empresa A.`);
    return;
  }
  const { id, fileId } = alvo;
  const casos = [
    ['ler os endereços da pessoa da empresa A', 'GET', `/people/${id}/addresses`],
    ['ler os documentos da pessoa da empresa A', 'GET', `/people/${id}/documents`],
    ['ler os papéis da pessoa da empresa A', 'GET', `/people/${id}/roles`],
    ['cadastrar endereço para a pessoa da empresa A', 'POST', `/people/${id}/addresses`, { street: 'ACEITE-M9 tentativa da outra empresa', city: 'X', state: 'SP' }],
    ['cadastrar papel para a pessoa da empresa A', 'POST', `/people/${id}/roles`, { roleCode: 'FIADOR' }],
    ['cadastrar documento para a pessoa da empresa A', 'POST', `/people/${id}/documents`, { documentType: 'CNH', fileId: fileId || '00000000-0000-4000-8000-000000000000' }],
  ];
  for (const [nome, metodo, rota, corpo] of casos) {
    const r = await ctx.outra.chamar(metodo, rota, corpo);
    ctx.rel.conferir(CENARIO, `outra empresa NÃO consegue ${nome}`, barrado(r), `${metodo} ${rota.replace(/[0-9a-f-]{36}/g, ':id')} -> ${resumo(r)}`);
  }
  for (const sufixo of ['', '/content', '/download']) {
    if (!fileId) { ctx.rel.conferir(CENARIO, `outra empresa NÃO consegue ler o arquivo do documento da empresa A (${sufixo || 'ficha'})`, null, 'Sem arquivo fictício na empresa A.'); continue; }
    const r = await ctx.outra.chamar('GET', `/files/${fileId}${sufixo}`);
    ctx.rel.conferir(CENARIO, `outra empresa NÃO consegue ler o arquivo do documento da empresa A (${sufixo || 'ficha'})`, barrado(r), `GET /files/:id${sufixo} -> ${resumo(r)}`);
  }

  // Lista conferida por id e por empresa: nada de A (nem com outro nome) e só pessoas da outra empresa ou vinculadas a ela.
  const doTeste = new Set([ctx.ids.pessoaOk, ctx.ids.pessoaOptOut, id].filter(Boolean));
  const r = await ctx.outra.chamar('GET', '/people');
  const itens = lista(r);
  const deA = itens.filter((p) => doTeste.has(p.id) || (ctx.admin.companyId && p.companyId === ctx.admin.companyId));
  const estranhos = itens.filter((p) => !(p.vinculo && p.vinculo.origem === 'VINCULADA') && ctx.outra.companyId && p.companyId !== ctx.outra.companyId);
  ctx.rel.conferir(CENARIO, 'a lista de contatos da outra empresa não traz pessoa da empresa A (conferido por id e por empresa, não pelo nome)', r.status === 200 && deA.length === 0 && estranhos.length === 0,
    `GET /people -> ${resumo(r)}, ${itens.length} contatos, ${deA.length} da empresa A, ${estranhos.length} de outra empresa sem vínculo`);

  // Mesmo CPF/CNPJ na outra empresa do MESMO grupo: 409 que convida ao vínculo, sem id nem nome (nunca cria nada).
  if (ctx.outra.groupId && ctx.outra.groupId === ctx.admin.groupId && alvo.cpf) {
    const c = await ctx.outra.chamar('POST', '/people', { personType: 'PF', legalName: 'ACEITE-M9 tentativa com o CPF da empresa A', taxIdNormalized: alvo.cpf });
    const vazou = c.texto.includes(id) || c.texto.includes(NOME_DOC);
    ctx.rel.conferir(CENARIO, 'o mesmo CPF na outra empresa do grupo é recusado como convite ao vínculo (409 PERSON_TAX_ID_IN_GROUP), sem id nem nome', c.status === 409 && c.erro && c.erro.code === 'PERSON_TAX_ID_IN_GROUP' && !vazou,
      `POST /people com o CPF da pessoa de A -> ${resumo(c)}${vazou ? ' (a resposta trouxe id ou nome)' : ''}`);
  } else {
    ctx.rel.conferir(CENARIO, 'o mesmo CPF na outra empresa do grupo é recusado como convite ao vínculo (409 PERSON_TAX_ID_IN_GROUP), sem id nem nome', null, 'A outra empresa não é do mesmo grupo da empresa A, ou o administrador vê o CPF da pessoa fictícia mascarado: a conferência não se aplica.');
  }

  const depois = {};
  for (const s of ['addresses', 'documents', 'roles']) depois[s] = lista(await ctx.admin.chamar('GET', `/people/${id}/${s}`)).length;
  const igual = ['addresses', 'documents', 'roles'].every((s) => depois[s] === alvo.contagem[s]);
  ctx.rel.conferir(CENARIO, 'nada foi gravado nos endereços, documentos e papéis da pessoa da empresa A pela outra empresa', igual,
    `antes ${JSON.stringify(alvo.contagem)}, depois ${JSON.stringify(depois)}`);
}

module.exports = { executar, prepararPessoaComDocumento, NOME_DOC };
