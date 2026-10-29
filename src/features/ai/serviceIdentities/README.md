# serviceIdentities

Identidade de serviço da NAY (M9-D017): permissões FIXAS e só de leitura por empresa e agente, usadas em tarefa automática (sem usuário). `ai.service_identities` tem RLS FORCE e CHECK de leitura; criar e alterar exige `ai:admin` e grava auditoria antes/depois. Rotas: `GET/POST /v1/ai/service-identities` e `PATCH /v1/ai/service-identities/:id`. Nome nos logs: `service:<AGENTE>@<empresa>`.
