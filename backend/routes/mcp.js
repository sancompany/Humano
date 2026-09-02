/**
 * SAN & CO. — backend/routes/mcp.js
 * Adaptador HTTP do catálogo de ferramentas.
 *
 * Expõe as mesmas ferramentas do servidor MCP por HTTP, para o frontend
 * consumir sem falar MCP. A regra de negócio não é repetida aqui: este
 * arquivo só traduz requisição em chamada de ferramenta.
 *
 *   GET  /api/mcp/tools              catálogo (equivale a tools/list)
 *   POST /api/mcp/tools/:nome        executa (equivale a tools/call)
 *
 * Para ligar o servidor MCP de verdade — o que dá a Hermes, Prometeu e
 * Hefesto acesso direto — o mesmo catálogo é registrado no SDK oficial:
 *
 *   import { Server } from '@modelcontextprotocol/sdk/server/index.js';
 *   import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 *   import { ListToolsRequestSchema, CallToolRequestSchema }
 *     from '@modelcontextprotocol/sdk/types.js';
 *
 *   const servidor = new Server({ name: 'san-and-co', version: '1.0.0' },
 *                               { capabilities: { tools: {} } });
 *   servidor.setRequestHandler(ListToolsRequestSchema,
 *     async () => ({ tools: listarFerramentas() }));
 *   servidor.setRequestHandler(CallToolRequestSchema,
 *     async (req) => executarFerramenta(req.params.name, req.params.arguments));
 *   await servidor.connect(new StdioServerTransport());
 */

import { Router } from 'express';
import { listarFerramentas, executarFerramenta } from '../services/mcpTools.js';

const rotas = Router();

/** Catálogo público: nomes, descrições e schemas, sem os handlers. */
rotas.get('/tools', (_req, resposta) => {
  resposta.json({ tools: listarFerramentas() });
});

/** Execução de uma ferramenta. */
rotas.post('/tools/:nome', async (requisicao, resposta) => {
  const resultado = await executarFerramenta(requisicao.params.nome, requisicao.body ?? {});

  // erro de ferramenta é 200 com isError: é resposta de negócio, não falha
  // de protocolo. 4xx aqui faria o cliente tratar como bug de rede.
  resposta.json(resultado);
});

export default rotas;
