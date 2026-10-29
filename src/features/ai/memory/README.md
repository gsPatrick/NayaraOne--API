# memory

MemoryService: memória empresarial estruturada da NAY (M9-D009). Guarda fatos operacionais autorizados, nunca a conversa inteira.

- Tabela `ai.memories` (migrations 732 e 733): quatro tipos (`DECISION`, `COMPANY_PREFERENCE`, `APPROVED_PROCEDURE`, `RECOMMENDATION_OUTCOME`), escopo `COMPANY`/`USER`/`AGENT`/`SESSION`, origem (`source_type` + `source_id`), classificação, finalidade, validade obrigatória e estados `ACTIVE`, `INVALIDATED`, `EXPIRED`, `SUPERSEDED`. Nada se apaga (gatilho); corrigir cria outra versão.
- `memory.service.js` é a fachada; `MemoryService.js` a classe usada pela NAY. Uma responsabilidade por arquivo: `memory.save` (gravar), `memory.change` (invalidar e corrigir), `memory.recall` (lembrar, listar e ler), `memory.propose` (a NAY propõe; uma pessoa grava), `memory.expire` (job), `memory.value` + `memory.schema` + `memory.pii` (valor estruturado e dado pessoal), `memory.policy` (quem pode o quê), `memory.validity` (prazos), `memory.context` (memória como fonte do ContextBuilder).
- Parâmetros `ia.memoria.*` em `memory.settings.js` (aba IA NAY de Configurações); rotas `/v1/ai/memories` em `memory.routes.js`; rotina diária `src/engines/jobs/aiMemoryExpiryJob.js`.
- Decisões: DI-D009-1 a DI-D009-7 em `Maturacao/demandas/decisoes-de-implementacao.md`.
