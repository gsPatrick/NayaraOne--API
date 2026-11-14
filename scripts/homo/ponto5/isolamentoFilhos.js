'use strict';
/**
 * Ponto 5, parte 4 (amplia o cenário (c) do roteiro geral): a outra empresa contra os FILHOS da pessoa da empresa A — endereço,
 * documento, papel, contato, consentimento e o ARQUIVO do documento — lendo e gravando, e as listas conferidas por id e por
 * empresa. Prepara pela API, de forma idempotente (nome exato), a pessoa "ACEITE-M9 P5 Pessoa com Documento" na empresa A, com CPF
 * fictício, contato, consentimento, endereço, papel e documento com um PDF fictício (o PDF passa pelo antivírus do ambiente), e a
 * pessoa "ACEITE-M9 P5 Contato da Outra Empresa" na outra empresa (controle: a lista dela não vem vazia por falta de acesso).
 * Depois confere que a empresa A continua com as mesmas contagens.
 * O mesmo CPF/CNPJ em outra empresa do grupo continua recusado (409; desde o vínculo da pessoa por empresa, DI-M9I-2, o código é
 * PERSON_TAX_ID_IN_GROUP, convite ao vínculo em vez de cadastro duplicado), sem
 * devolver nada da pessoa da empresa A.
 */
const CENARIO = '(4) isolamento entre empresas';
const NOME_DOC = 'ACEITE-M9 P5 Pessoa com Documento';
const NOME_B = 'ACEITE-M9 P5 Contato da Outra Empresa';
const PDF = Buffer.from('%PDF-1.4\n% ACEITE-M9 documento ficticio\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
const FILHOS = ['addresses', 'documents', 'roles', 'contacts', 'consents'];
const barrado = (r) => [403, 404].includes(r.status);
const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;
const lista = (r) => (Array.isArray(r.dados) ? r.dados : []);
const anon = (rota) => rota.replace(/[0-9a-f-]{36}/g, ':id');

function cpfFicticio() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (arr) => { const f = arr.length + 1; const r = (arr.reduce((acc, d, i) => acc + d * (f - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  n.push(dv(n)); n.push(dv(n));
  return n.join('');
}

async function contagens(sessao, id) {
  const out = {};
  for (const s of FILHOS) out[s] = lista(await sessao.chamar('GET', `/people/${id}/${s}`)).length;
  return out;
}

/** Pessoa fictícia (nome exato) na sessão; cria com o corpo informado se não existir. */
async function garantir(sessao, nome, corpo) {
  const achada = lista(await sessao.chamar('GET', '/people')).find((p) => p.legalName === nome);
  if (achada) return achada;
  const r = await sessao.chamar('POST', '/people', { personType: 'PF', legalName: nome, ...corpo });
  if (r.status !== 201) throw new Error(`Não consegui criar "${nome}": ${resumo(r)}`);
  return r.dados;
}

/** Pessoa da empresa A com CPF, contato, endereço, papel e documento com arquivo. Falha de preparação é falha do roteiro (nada fica sem verificar). */
async function preparar(ctx) {
  const admin = ctx.admin;
  const criada = await garantir(admin, NOME_DOC, { taxIdNormalized: cpfFicticio() });
  const id = criada.id;
  const pessoa = (await admin.chamar('GET', `/people/${id}`)).dados || {};
  const cpf = /^\d{11}$/.test(String(pessoa.taxIdNormalized || '')) ? pessoa.taxIdNormalized : null;
  if (!cpf) throw new Error(`O CPF fictício de "${NOME_DOC}" não voltou legível para o administrador (GET /people/:id).`);
  ctx.ids.pessoaDocumento = id;
  if (!lista(await admin.chamar('GET', `/people/${id}/contacts`)).length) {
    const c = await admin.chamar('POST', `/people/${id}/contacts`, { contactType: 'EMAIL', valueNormalized: 'aceite-m9-p5-documento@exemplo.invalid', isPrimary: true });
    if (c.status !== 201) throw new Error(`Não consegui gravar o contato fictício: ${resumo(c)}`);
  }
  if (!lista(await admin.chamar('GET', `/people/${id}/consents`)).length) {
    const c = await admin.chamar('POST', `/people/${id}/consents`, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_IN' });
    if (c.status !== 201) throw new Error(`Não consegui gravar o consentimento fictício: ${resumo(c)}`);
  }
  if (!lista(await admin.chamar('GET', `/people/${id}/addresses`)).length) {
    const a = await admin.chamar('POST', `/people/${id}/addresses`, { street: 'ACEITE-M9 Rua do Isolamento', number: '5', zipCode: '01310100', city: 'São Paulo', state: 'SP' });
    if (a.status !== 201) throw new Error(`Não consegui gravar o endereço fictício: ${resumo(a)}`);
  }
  if (!lista(await admin.chamar('GET', `/people/${id}/roles`)).length) {
    const p = await admin.chamar('POST', `/people/${id}/roles`, { roleCode: 'CLIENTE' });
    if (p.status !== 201) throw new Error(`Não consegui gravar o papel fictício: ${resumo(p)}`);
  }
  let doc = lista(await admin.chamar('GET', `/people/${id}/documents`))[0] || null;
  if (!doc) {
    const arq = await admin.chamar('POST', '/files', { fileName: 'aceite-m9-p5-documento.pdf', mimeType: 'application/pdf', contentBase64: PDF, category: 'people' });
    if (arq.status !== 201 || !arq.dados || !arq.dados.id) throw new Error(`O arquivo fictício não foi aceito na empresa A: ${resumo(arq)}`);
    const d = await admin.chamar('POST', `/people/${id}/documents`, { documentType: 'RG', fileId: arq.dados.id });
    if (d.status !== 201) throw new Error(`Não consegui gravar o documento fictício: ${resumo(d)}`);
    doc = d.dados;
  }
  ctx.ids.documentoId = doc.id; ctx.ids.arquivoId = doc.fileId;
  ctx.rel.item('Pessoa fictícia', `${NOME_DOC} (CPF fictício, contato, endereço, papel e documento)`, 'na empresa A', id, `/painel/pessoas/${id}`);
  ctx.rel.item('Documento fictício (com arquivo PDF)', `RG de "${NOME_DOC}"`, 'na empresa A', doc.id, `arquivo ${doc.fileId}`);
  const deB = await garantir(ctx.outra, NOME_B, {});
  ctx.ids.pessoaOutraEmpresa = deB.id;
  ctx.rel.item('Pessoa fictícia', NOME_B, 'na OUTRA empresa (controle da lista dela)', deB.id, 'entrando como o usuário da outra empresa');
  return { id, cpf, fileId: doc.fileId, antes: await contagens(admin, id) };
}

async function executar(ctx) {
  console.log(`\n--- ${CENARIO}: filhos da pessoa, arquivo e listas ---`);
  const alvo = await preparar(ctx);
  const { id, fileId } = alvo;
  const casos = [
    ...FILHOS.map((s) => [`ler ${s} da pessoa da empresa A`, 'GET', `/people/${id}/${s}`]),
    ['cadastrar endereço na pessoa da empresa A', 'POST', `/people/${id}/addresses`, { street: 'ACEITE-M9 tentativa da outra empresa', number: '1', city: 'X', state: 'SP' }],
    ['cadastrar papel na pessoa da empresa A', 'POST', `/people/${id}/roles`, { roleCode: 'FIADOR' }],
    ['cadastrar documento na pessoa da empresa A', 'POST', `/people/${id}/documents`, { documentType: 'CNH', fileId }],
    ['cadastrar contato na pessoa da empresa A', 'POST', `/people/${id}/contacts`, { contactType: 'EMAIL', valueNormalized: 'aceite-m9-intruso@exemplo.invalid' }],
    ['ler a ficha do arquivo do documento da empresa A', 'GET', `/files/${fileId}`],
    ['baixar o conteúdo do arquivo da empresa A', 'GET', `/files/${fileId}/content`],
    ['pedir o download do arquivo da empresa A', 'GET', `/files/${fileId}/download`],
  ];
  for (const [nome, metodo, rota, corpo] of casos) {
    const r = await ctx.outra.chamar(metodo, rota, corpo);
    const semDado = !r.texto.includes(id) || r.status >= 400;
    ctx.rel.conferir(CENARIO, `outra empresa NÃO consegue ${nome}`, barrado(r) && semDado, `${metodo} ${anon(rota)} -> ${resumo(r)}`);
  }
  if (alvo.cpf && ctx.outra.groupId === ctx.admin.groupId) {
    const c = await ctx.outra.chamar('POST', '/people', { personType: 'PF', legalName: 'ACEITE-M9 P5 tentativa com o CPF da empresa A', taxIdNormalized: alvo.cpf });
    const vazou = c.texto.includes(id) || c.texto.includes(NOME_DOC);
    ctx.rel.conferir(CENARIO, 'o mesmo CPF na outra empresa do grupo é recusado (409 PERSON_TAX_ID_IN_GROUP, convite ao vínculo) sem devolver nada da pessoa da empresa A',
      c.status === 409 && c.erro && c.erro.code === 'PERSON_TAX_ID_IN_GROUP' && !vazou, `POST /people com o CPF da pessoa de A -> ${resumo(c)}${vazou ? ' (a resposta trouxe id ou nome)' : ''}`);
  }
  // a outra empresa enxerga a própria lista (controle: as recusas acima não são falta de acesso geral)
  const propria = await ctx.outra.chamar('GET', '/people');
  ctx.rel.conferir(CENARIO, 'controle: a outra empresa lê a própria lista (200), vê o próprio contato fictício e todos os itens são dela',
    propria.status === 200 && lista(propria).some((p) => p.id === ctx.ids.pessoaOutraEmpresa) && lista(propria).every((p) => p.companyId === ctx.outra.companyId),
    `GET /people -> ${resumo(propria)}, ${lista(propria).length} contatos, empresas distintas: ${[...new Set(lista(propria).map((p) => p.companyId))].join(', ') || 'nenhuma'}`);
  const depois = await contagens(ctx.admin, id);
  const igual = FILHOS.every((s) => depois[s] === alvo.antes[s]);
  const pessoa = await ctx.admin.chamar('GET', `/people/${id}`);
  const arquivo = await ctx.admin.chamar('GET', `/files/${fileId}`);
  ctx.rel.conferir(CENARIO, 'nada mudou na empresa A: mesmos endereços, documentos, papéis, contatos e consentimentos; pessoa e arquivo intactos',
    igual && pessoa.status === 200 && arquivo.status === 200, `antes ${JSON.stringify(alvo.antes)}, depois ${JSON.stringify(depois)}; pessoa ${pessoa.status}; arquivo ${arquivo.status}`);
}

module.exports = { executar, CENARIO };
