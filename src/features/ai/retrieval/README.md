# retrieval
RAG da NAY (M9-D022, M9-D023 e M9-D024): ingestão segura de arquivo, URL e conhecimento homologado e busca isolada por empresa e permissão.

- `ingestion.*`: pipeline autorização -> malware -> hash -> classificação -> leitura (`parse/`) -> segredos (`secretScanner.js`) e PII -> chunks (`chunker.js`) -> vetores (`embedder.js`) -> índice. Estados em `ai.ingestions`; recusa de conteúdo grava REJECTED (não lança), o controller converte em 422 depois do commit.
- `urlFetcher.js`: URL só por pedido humano, com a lista `ia.rag.dominios_permitidos` E a do guarda SSRF (`nay_document`); a rede é toda de `ssrfGuard.fetchExternalUrl` (M9-D245).
- `RetrievalService.js`: empresa/estado -> permissão/classificação (no banco, antes de ler conteúdo) -> similaridade e texto -> rerank determinístico -> dupla checagem na origem (`doubleCheck.js`) -> `ai_sources`. O resultado é `untrusted`; o RAG nunca soma permissão.
- `reconcileJob.js`: copia permissão e classificação da origem para os chunks (job `src/engines/jobs/aiRagJob.js`, a cada `ia.rag.reconciliar_minutos`).
- SQL só em `../readmodels/ragSupport.readmodel.js` (archGuard AI-004). Parâmetros `ia.rag.*` em `retrieval.settings.js`.
- Rotas: `POST /v1/ai/ingestions`, `GET /v1/ai/ingestions/:id`, `PUT /v1/ai/files/:fileId/classification`.

## Vigência e conflito (M9-D024)

- `vigencia.js`: uma fonte vale se `ACTIVE`, `effective_from <= agora` e (`effective_until` nulo ou `> agora`); data sem hora vale no dia de America/Sao_Paulo. O estado em cada recuperação é VIGENTE, REVOGADA, EXPIRADA, SUBSTITUIDA ou NAO_INICIADA.
- `retrieval.notVigent.js`: a fonte que casou com a pergunta mas não vale nunca entra na resposta; fica em `ai.ai_sources` com `used_in_answer = false` e o estado (limite `ia.rag.nao_vigentes_registrar_max`).
- `facts.js` e `conflictDetector.js`: só se compara o que tem chave de assunto (`fact_key` da entrada homologada ou linha `Fato: chave = valor` do documento, marcador `ia.rag.conflito.marcador`). Duas fontes distintas com valores diferentes divergem; versão nova da mesma origem não (SUPERSEDED). O orquestrador entrega a lista ao `validateGrounding` (D025) e a resposta não escolhe um lado (`orchestrator/grounding/conflictAnswer.js`).
- `expiry.js` e `revocation.js`: o job `src/engines/jobs/aiSourceExpiryJob.js` (a cada `ia.rag.vigencia.intervalo_horas`) marca EXPIRED o conhecimento e os chunks vencidos; `revokeSource` retira os chunks de uma origem revogada na mesma transação dela.
