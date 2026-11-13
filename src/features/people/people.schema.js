'use strict';

const { Person, PersonContact, PersonDocument, PersonAddress } = require('../../models');
const V = require('../../shared/validation/requestSchema');

/**
 * Tipo e tamanho dos campos de texto e de identificador de `POST /people` e `PATCH /people/:id`, conferidos na porta (verificação independente do
 * Marco 9, rodada 7, 12/11/2026; DI-M9R-21). Antes, `personType` com um objeto ou um número dava 500 (`toUpperCase is not a function`) e
 * `legalName`, `preferredName` ou `notes` maiores que a coluna davam 500 (`value too long`). O esquema é ABERTO (campo não citado passa, como
 * antes); os limites de texto vêm do modelo (o tamanho da coluna). As regras de negócio (PF ou PJ, nome obrigatório, documento válido) continuam no
 * serviço, com as mesmas mensagens.
 */
const contato = V.objetoAberto({
  contactType: V.textoDoModelo(PersonContact, 'contactType'),
  channel: V.textoDoModelo(PersonContact, 'contactType'),
  value: V.textoDoModelo(PersonContact, 'valueNormalized'),
  valueNormalized: V.textoDoModelo(PersonContact, 'valueNormalized'),
});
const documento = V.objetoAberto({
  documentType: V.textoDoModelo(PersonDocument, 'documentType'),
  fileId: V.identificador(),
  verificationStatus: V.textoDoModelo(PersonDocument, 'verificationStatus'),
  issuedAt: V.dataEmTexto(),
  expiresAt: V.dataEmTexto(),
});
const endereco = V.objetoAberto(Object.fromEntries(['zipCode', 'street', 'number', 'complement', 'neighborhood', 'city', 'state']
  .map((c) => [c, V.textoDoModelo(PersonAddress, c)]).concat([['validFrom', V.dataEmTexto()], ['validUntil', V.dataEmTexto()]])));
const papel = { type: ['string', 'object', 'null'], maxLength: 64, properties: { roleCode: V.texto(64), startsAt: V.dataEmTexto(), endsAt: V.dataEmTexto() }, descricao: 'um papel (texto ou objeto com "roleCode")' };

const camposDaPessoa = {
  personType: V.textoDoModelo(Person, 'personType'),
  legalName: V.textoDoModelo(Person, 'legalName'),
  preferredName: V.textoDoModelo(Person, 'preferredName'),
  // O serviço grava só os dígitos (coluna de 20); a tela pode mandar com a máscara.
  taxIdNormalized: V.texto(32),
  birthOrFoundationDate: V.dataEmTexto(),
  status: V.textoDoModelo(Person, 'status'),
};

const CRIAR = V.objetoAberto({
  ...camposDaPessoa,
  contacts: V.lista(contato),
  documents: V.lista(documento),
  roles: V.lista(papel),
  addresses: V.lista({ ...endereco, type: ['object', 'null'] }),
  address: { ...endereco, type: ['object', 'null'] },
});

const ATUALIZAR = V.objetoAberto({ ...camposDaPessoa, changeEvidence: V.objeto() });

/** `POST /people/:id/merge` (rodada 8, DI-M9R-25): o registro absorvido é um identificador em texto. */
const MESCLAR = V.objetoAberto({ absorbedId: V.identificador() });

/** Consulta de `GET /people` (rodada 8, DI-M9R-24): `personType` (ou `type`) e `status`, sempre texto. */
const LISTAR = V.objetoAberto({
  personType: V.textoDaConsulta({ max: 10 }),
  type: V.textoDaConsulta({ max: 10 }),
  status: V.textoDaConsulta({ max: 30 }),
});

module.exports = {
  validarCriacaoDePessoa: V.validarEntrada({ body: CRIAR }, 'PERSON_VALIDATION'),
  validarAtualizacaoDePessoa: V.validarEntrada({ body: ATUALIZAR }, 'PERSON_VALIDATION'),
  validarListagemDePessoas: V.validarEntrada({ query: LISTAR }, 'PERSON_VALIDATION'),
  validarMesclagem: V.validarEntrada({ body: MESCLAR }, 'PERSON_MERGE_VALIDATION'),
  ESQUEMAS: { CRIAR, ATUALIZAR, LISTAR, MESCLAR },
};
