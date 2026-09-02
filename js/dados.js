/**
 * SAN & CO. — js/dados.js
 * Camada agnóstica de dados financeiros.
 *
 * O PROBLEMA QUE ELA RESOLVE
 *   PF e PJ têm origens diferentes hoje: a pessoa física vem do Open Finance
 *   real, via backend; a jurídica ainda não tem CNPJ ativo em produção e vem
 *   de mock estruturado ou de arquivo .OFX importado à mão. As telas não
 *   podem saber disso. Elas pedem dados de um perfil e recebem sempre a
 *   mesma forma.
 *
 * REGRA DE LEITURA (cache first)
 *   Toda leitura sai do Supabase, através das rotas do nosso backend. A
 *   Pluggy só é consultada quando alguém manda sincronizar. Nenhuma função
 *   deste arquivo fala com a Pluggy.
 *
 * CONTRATO DE VALOR AUSENTE
 *   Número que ainda não existe é `null`, nunca `0` e nunca `NaN`. Zero é um
 *   saldo real; null é "ainda não sei", e é o que faz a interface desenhar
 *   R$ ---.---,-- em vez de mentir.
 */

import { bancoPorCodigo } from './bancos.js';

// Front (Live Server, 127.0.0.1:5500) e backend (Node, porta 3000) são
// origens diferentes — um caminho relativo tipo '/api' bateria no próprio
// Live Server, não no backend, e sempre falharia em silêncio (era isso,
// não o backend "fora do ar", que fazia tudo cair pro .OFX até aqui).
// Usa o mesmo hostname da página (127.0.0.1 ou localhost, o que for) e só
// troca a porta — funciona nos dois nomes sem precisar configurar nada.
const BASE_API = `https://san-humano.onrender.com`;
const TIMEOUT_MS = 8000;

/* ==================================================================
   1. FORMA CANÔNICA
   ================================================================== */

/** Esqueleto financeiro com tudo em null — a forma que as telas esperam. */
export function moldeFinanceiro(perfil) {
  return {
    perfil,
    rotulo: perfil === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física',
    origem: 'vazio',
    sincronizadoEm: null,
    ultimoEnvioOfx: null,
    /** contas conectadas: { id, nome, saldo, agencia, numero } */
    contas: [],
    fluxo: {
      entradas: { total: null, variacao: null, anterior: null, subtitulo: 'Aguardando sincronização' },
      saidas:   { total: null, variacao: null, anterior: null, subtitulo: 'Aguardando sincronização' }
    },
    cartoes: { faturasAbertas: null, limiteTotal: null, limiteDisponivel: null, detalhes: [] },
    // cada cartão em `detalhes` pode trazer { movimentos: [] } com as compras
    // e os pagamentos daquela fatura — é o que a aba de detalhe abre
    projecao: { d7: null, d30: null },
    extrato: []
  };
}

/** Esqueleto de patrimônio com tudo em null. */
export function moldeInvestimentos(perfil) {
  return {
    perfil,
    origem: 'vazio',
    totalInvestido: null,
    liquidezImediata: null,
    variacaoMes: null,
    alocacao: [],
    ativos: []
  };
}

/* ==================================================================
   2. MOVIMENTOS IMPORTADOS
   Não há mais mock. Enquanto o backend não sobe, a única fonte real é o
   arquivo .OFX que você arrasta na tela — os movimentos ficam aqui, em
   memória, e os totais são DERIVADOS deles.

   Derivar em vez de guardar total pronto é o que impede o painel de
   mentir: se o número não bate com a soma das linhas, não existe número.
   É também o formato que o Supabase vai devolver, transação a transação.
   ================================================================== */

/** { PF: [...movimentos], PJ: [...movimentos] } — some ao recarregar. */
const importados = { PF: [], PJ: [] };

/** Contas identificadas nos arquivos importados, por perfil. */
const contasImportadas = { PF: [], PJ: [] };

/**
 * Registra a conta que veio no cabeçalho do .OFX. Se a mesma conta for
 * importada de novo, o saldo é atualizado em vez de duplicar a linha.
 * @param {object|null} conta
 * @param {'PF'|'PJ'} perfil
 */
export function registrarConta(conta, perfil) {
  if (!conta?.id) return;
  const lista = contasImportadas[perfil] ?? [];
  const existente = lista.findIndex((c) => c.id === conta.id);
  if (existente >= 0) lista[existente] = { ...lista[existente], ...conta };
  else lista.push(conta);
  contasImportadas[perfil] = lista;
}

/** Contas conhecidas de um perfil. */
export function contasDe(perfil) {
  return contasImportadas[perfil] ?? [];
}

/**
 * Guarda movimentos vindos de um .OFX, sem duplicar o que já entrou.
 * A deduplicação é pelo FITID do arquivo, que é o identificador que o
 * banco promete ser único — reimportar o mesmo extrato não dobra nada.
 *
 * @param {Array<object>} movimentos
 * @param {'PF'|'PJ'} perfil
 * @returns {{ novos: number, repetidos: number, total: number }}
 */
export function registrarMovimentos(movimentos, perfil) {
  const atuais = importados[perfil] ?? [];
  const jaVistos = new Set(atuais.map((m) => m.id));

  const novos = movimentos.filter((m) => !jaVistos.has(m.id));
  importados[perfil] = [...atuais, ...novos].sort((a, b) => b.data.localeCompare(a.data));

  // TODO: enviar `novos` ao Supabase pela rota do backend.
  return {
    novos: novos.length,
    repetidos: movimentos.length - novos.length,
    total: importados[perfil].length
  };
}

/** Descarta os movimentos e as contas importadas de um perfil. */
export function limparImportados(perfil) {
  importados[perfil] = [];
  contasImportadas[perfil] = [];
}

/** Movimentos disponíveis de um perfil. */
export function movimentosDe(perfil) {
  return importados[perfil] ?? [];
}

/* ==================================================================
   3. NORMALIZAÇÃO
   ================================================================== */

/** Número utilizável ou null. Barra NaN, string vazia, undefined. */
function num(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

const CATEGORIAS = ['Renda Fixa', 'Renda Variável', 'Fundos/Previdência', 'Cripto/Outros'];

/**
 * Completa cada ativo com a rentabilidade e monta a alocação percentual.
 * Rentabilidade é derivada, nunca confiada: se vier do banco divergente do
 * aplicado e do atual, o número na tela seria irreconciliável.
 */
export function normalizarInvestimentos(bruto, perfil) {
  if (!bruto || !Array.isArray(bruto.ativos)) return moldeInvestimentos(perfil);

  const ativos = bruto.ativos.map((ativo) => {
    const aplicado = num(ativo.valor_aplicado);
    const atual = num(ativo.valor_atual);
    const temAmbos = aplicado !== null && atual !== null;

    return {
      ...ativo,
      categoria: CATEGORIAS.includes(ativo.categoria) ? ativo.categoria : 'Cripto/Outros',
      valor_aplicado: aplicado,
      valor_atual: atual,
      rentabilidade_reais: temAmbos ? atual - aplicado : null,
      rentabilidade_pct: temAmbos && aplicado > 0 ? ((atual - aplicado) / aplicado) * 100 : null
    };
  });

  const somaAtual = ativos.reduce((s, a) => s + (a.valor_atual ?? 0), 0);

  const alocacao = CATEGORIAS.map((categoria) => {
    const doGrupo = ativos.filter((a) => a.categoria === categoria);
    const valor = doGrupo.reduce((s, a) => s + (a.valor_atual ?? 0), 0);
    return {
      categoria,
      valor: doGrupo.length ? valor : null,
      percentual: somaAtual > 0 ? (valor / somaAtual) * 100 : null,
      quantidade: doGrupo.length
    };
  });

  return {
    perfil,
    origem: bruto.origem ?? 'supabase',
    totalInvestido: num(bruto.totalInvestido) ?? (somaAtual || null),
    liquidezImediata: num(bruto.liquidezImediata),
    variacaoMes: num(bruto.variacaoMes),
    alocacao,
    ativos
  };
}

/** Garante a forma canônica do bloco financeiro, venha de onde vier. */
export function normalizarFinanceiro(bruto, perfil) {
  const molde = moldeFinanceiro(perfil);
  if (!bruto) return molde;

  const lente = (origem = {}, padrao) => ({
    total: num(origem.total),
    variacao: num(origem.variacao),
    anterior: num(origem.anterior),
    subtitulo: origem.subtitulo || padrao
  });

  return {
    perfil,
    rotulo: bruto.rotulo ?? molde.rotulo,
    origem: bruto.origem ?? 'supabase',
    sincronizadoEm: bruto.sincronizadoEm ?? null,
    ultimoEnvioOfx: bruto.ultimoEnvioOfx ?? null,
    contas: (bruto.contas ?? []).map((c) => ({ ...c, saldo: num(c.saldo) })),
    fluxo: {
      entradas: lente(bruto.fluxo?.entradas, molde.fluxo.entradas.subtitulo),
      saidas:   lente(bruto.fluxo?.saidas,   molde.fluxo.saidas.subtitulo)
    },
    cartoes: {
      faturasAbertas: num(bruto.cartoes?.faturasAbertas),
      limiteTotal: num(bruto.cartoes?.limiteTotal),
      limiteDisponivel: num(bruto.cartoes?.limiteDisponivel),
      detalhes: (bruto.cartoes?.detalhes ?? []).map((c) => ({
        ...c,
        valor: num(c.valor),
        movimentos: (c.movimentos ?? []).map((m) => ({ ...m, valor: num(m.valor) }))
      }))
    },
    projecao: { d7: num(bruto.projecao?.d7), d30: num(bruto.projecao?.d30) },
    extrato: (bruto.extrato ?? []).map((m) => ({ ...m, valor: num(m.valor) }))
  };
}

/* ==================================================================
   3.1 DERIVAÇÃO A PARTIR DOS MOVIMENTOS
   ================================================================== */

/** 'AAAA-MM' de uma data ISO. */
function competencia(iso) {
  return String(iso).slice(0, 7);
}

/** Mês anterior a uma competência: '2026-01' -> '2025-12'. */
function mesAnterior(chave) {
  const [ano, mes] = chave.split('-').map(Number);
  const d = new Date(ano, mes - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Soma de um tipo dentro de uma competência. */
function somar(movimentos, chave, tipo) {
  return movimentos
    .filter((m) => m.tipo === tipo && competencia(m.data) === chave)
    .reduce((soma, m) => soma + (m.valor ?? 0), 0);
}

/**
 * Monta o bloco financeiro a partir de uma lista de movimentos.
 *
 * O mês de referência é o do movimento mais recente, não o mês do
 * calendário: se você importa um extrato de julho em agosto, o painel
 * mostra julho em vez de um mês vazio.
 *
 * @param {Array<object>} movimentos
 * @param {'PF'|'PJ'} perfil
 */
export function derivarFinanceiro(movimentos, perfil) {
  const molde = moldeFinanceiro(perfil);
  const contas = contasDe(perfil);
  if (!movimentos.length) return { ...molde, contas };

  const ordenados = [...movimentos].sort((a, b) => b.data.localeCompare(a.data));
  const atual = competencia(ordenados[0].data);
  const anterior = mesAnterior(atual);

  const lente = (tipo, descricao) => {
    const total = somar(ordenados, atual, tipo);
    const passado = somar(ordenados, anterior, tipo);
    const houvePassado = ordenados.some((m) => competencia(m.data) === anterior);

    return {
      total,
      anterior: houvePassado ? passado : null,
      variacao: houvePassado && passado > 0 ? ((total - passado) / passado) * 100 : null,
      subtitulo: descricao
    };
  };

  return {
    ...molde,
    contas,
    origem: 'ofx',
    sincronizadoEm: null,
    ultimoEnvioOfx: new Date().toISOString().slice(0, 10),
    fluxo: {
      entradas: lente('entrada', 'Importado do extrato bancário'),
      saidas: lente('saida', 'Importado do extrato bancário')
    },
    extrato: ordenados
  };
}

/* ==================================================================
   3.3 PROJETOS — motor de auto-provisionamento via checkout (Asaas)
   Segregação Pessoal/Comercial é uma camada independente do perfil
   PF/PJ: PF/PJ é sobre CPF/CNPJ; escopo é sobre "é meu ou é de cliente".
   Um projeto PJ pode ser pessoal (o próprio negócio do titular) e um
   projeto PF pode, em tese, ser comercial (cliente pagando pessoa física).

   handleCheckoutEvent() é a função que o backend vai chamar quando o
   webhook do Asaas existir — a assinatura já é a definitiva. Por
   enquanto, o único jeito real de um projeto nascer é a criação manual
   (criarProjetoManual), porque não existe webhook nenhum ainda: fingir
   que "chegou uma venda" sem o dado ter vindo de algum lugar real seria
   inventar dado, e isso este arquivo nunca faz.
   ================================================================== */

let projetosPorPerfil = { PF: [], PJ: [] };
let proximoProjetoId = 1;

/**
 * @param {{ id: string, nome: string, escopo: 'pessoal'|'comercial',
 *           clienteId?: string|null, categoria?: string }} dados
 */
function moldeProjeto(dados) {
  return {
    id: dados.id,
    nome: dados.nome,
    escopo: dados.escopo === 'comercial' ? 'comercial' : 'pessoal',
    clienteId: dados.clienteId ?? null,
    status: 'ativo',              // 'ativo' | 'construcao' | 'desativado'
    tipoEncerramento: null,       // 'temporario' | 'permanente' | null
    categoria: dados.categoria || 'Geral',
    origemCheckout: {
      chavePublica: dados.apiKeyPrefix ?? null,
      primeiraTransacao: null,
      totalTransacionado: 0
    },
    faturamentoMes: 0,
    despesasMes: 0,
    lucroLiquido: 0,
    margemLucro: null,
    historico6m: [null, null, null, null, null, null],
    diagnosticoIA: null,          // Lumen Lux ainda não lê nada — sem backend, sem diagnóstico
    kpis: { ticketMedio: null, cac: null, ltv: null, totalVendas: 0 }
  };
}

export function projetosDe(perfil) {
  return projetosPorPerfil[perfil] ?? [];
}

/**
 * Criação manual — hoje é o ÚNICO caminho real de um projeto nascer,
 * porque não há webhook do Asaas ainda. Usa o mesmo molde que
 * handleCheckoutEvent usaria, para o dia em que o webhook existir não
 * precisar de um formato de projeto diferente.
 */
export function criarProjetoManual({ nome, escopo, categoria }, perfil) {
  const projeto = moldeProjeto({ id: `manual-${proximoProjetoId++}`, nome, escopo, categoria });
  projetosPorPerfil[perfil] = [...(projetosPorPerfil[perfil] ?? []), projeto];
  return projeto;
}

/**
 * O handler que o backend vai chamar de verdade quando o webhook do
 * Asaas existir. Auto-provisiona o projeto no primeiro evento com aquele
 * project_id, e depois só acumula faturamento.
 *
 * @param {{ projectId, projectName, scope, clientId, apiKeyPrefix,
 *           categoria, valor, tipo }} payload
 * @param {'PF'|'PJ'} perfil
 * @returns {object} o projeto criado ou atualizado
 */
export function handleCheckoutEvent(payload, perfil) {
  const lista = projetosPorPerfil[perfil] ?? (projetosPorPerfil[perfil] = []);
  let projeto = lista.find((p) => p.id === payload.projectId);

  if (!projeto) {
    projeto = moldeProjeto({
      id: payload.projectId,
      nome: payload.projectName,
      escopo: payload.scope,
      clienteId: payload.clientId,
      categoria: payload.categoria,
      apiKeyPrefix: payload.apiKeyPrefix
    });
    projeto.origemCheckout.primeiraTransacao = new Date().toISOString();
    lista.push(projeto);
  }

  if (payload.valor && payload.tipo === 'entrada') {
    projeto.faturamentoMes += payload.valor;
    projeto.origemCheckout.totalTransacionado += payload.valor;
    projeto.lucroLiquido = projeto.faturamentoMes - projeto.despesasMes;
    projeto.margemLucro = projeto.faturamentoMes > 0
      ? Number(((projeto.lucroLiquido / projeto.faturamentoMes) * 100).toFixed(1))
      : 0;
    projeto.kpis.totalVendas += 1;
    projeto.kpis.ticketMedio = Number((projeto.faturamentoMes / projeto.kpis.totalVendas).toFixed(2));
  }

  return projeto;
}

/* ==================================================================
   3.2 EVOLUÇÃO DE SALDO (12 MESES) — para o gráfico da Overview
   ================================================================== */

/**
 * Série mensal de saldo dos últimos 12 meses, derivada dos movimentos —
 * nunca inventada. Sem saldo atual conhecido (nenhuma conta com `saldo`
 * carregado), a série vira "relativa": começa em zero e mostra a FORMA da
 * variação, não o valor absoluto — melhor admitir isso do que desenhar um
 * eixo com números que não existem.
 *
 * @param {Array<object>} movimentos
 * @param {Array<{saldo: number|null}>} contas
 * @returns {{ pontos: Array<{mes:string, saldo:number}>, absoluto: boolean, suficiente: boolean }}
 */
export function derivarEvolucaoSaldo(movimentos, contas = []) {
  if (!movimentos.length) return { pontos: [], absoluto: false, suficiente: false };

  const porMes = new Map();
  movimentos.forEach((m) => {
    const chave = competencia(m.data);
    const delta = m.tipo === 'entrada' ? (m.valor ?? 0) : -(m.valor ?? 0);
    porMes.set(chave, (porMes.get(chave) ?? 0) + delta);
  });

  const meses = [...porMes.keys()].sort().slice(-12);
  if (meses.length < 2) return { pontos: [], absoluto: false, suficiente: false };

  // âncora: se alguma conta tem saldo conhecido, o ÚLTIMO ponto vira esse
  // total real, e os anteriores são obtidos subtraindo a variação de cada
  // mês para trás — assim o gráfico termina no número que a pessoa confere
  // na própria conta, não num total inventado.
  const somaContas = contas.reduce((s, c) => s + (Number.isFinite(c.saldo) ? c.saldo : 0), 0);
  const temAncora = contas.some((c) => Number.isFinite(c.saldo));

  const deltas = meses.map((chave) => porMes.get(chave));
  const somaDeltas = deltas.reduce((s, d) => s + d, 0);

  let acumulado = temAncora ? somaContas - somaDeltas : 0;
  const pontos = meses.map((mes, i) => {
    acumulado += deltas[i];
    return { mes, saldo: acumulado };
  });

  return { pontos, absoluto: temAncora, suficiente: true };
}

/* ==================================================================
   3.4 CATEGORIZAÇÃO DE GASTOS
   A categoria de cada movimento vem pronta da Pluggy — este arquivo nunca
   inventa uma taxonomia própria, só traduz o rótulo para português. Um
   movimento importado por .OFX não carrega categoria nenhuma (o formato
   não tem esse campo); ele fica honestamente "Sem categoria" em vez de
   herdar um valor chutado por palavra-chave na descrição.
   ================================================================== */

/**
 * Rótulo da Pluggy (inglês) -> rótulo em português exibido na tela.
 * Lista viva: cresce conforme categorias novas aparecerem na sincronização
 * real. Uma categoria que ainda não está aqui não quebra nada — ela
 * simplesmente aparece no idioma original em vez de ficar genérica.
 */
const TRADUCAO_CATEGORIA = {
  'Loans and financing':            'Empréstimos e financiamentos',
  'Electronics':                     'Eletrônicos',
  'Late payment and overdraft costs':'Juros e multas por atraso',
  'Automotive':                      'Automóveis',
  'Investments':                     'Investimentos',
  'Shopping':                        'Compras',
  'Digital services':                'Serviços digitais',
  'Interests charged':               'Juros cobrados',
  'Transfer - Cash':                 'Transferência — Dinheiro',
  'Transfer – Cash':                 'Transferência — Dinheiro',   // variante com travessão (en dash) que a Pluggy usa
  'Eating out':                      'Alimentação fora',
  'Groceries':                       'Supermercado',
  'Services':                        'Serviços',
  'Taxes':                           'Impostos',
  'Health':                          'Saúde',
  'Education':                       'Educação',
  'Leisure':                         'Lazer',
  'Travel':                          'Viagens',
  'Insurance':                       'Seguros',
  'Income':                          'Renda',
  'Salary':                          'Salário',
  'Transfer':                        'Transferência',
  'Utilities':                       'Contas de consumo',
  'Telecommunication':               'Telecomunicações',
  'Housing':                         'Moradia'
};

/**
 * Traduz o rótulo de categoria que veio da fonte de dado (Pluggy ou
 * Supabase). Categoria ausente vira "Sem categoria" — nunca inventada;
 * categoria presente mas ainda não mapeada aparece no original, nunca
 * escondida atrás de um rótulo genérico.
 * @param {string|null|undefined} bruta
 */
export function traduzirCategoria(bruta) {
  if (!bruta) return 'Sem categoria';
  const chave = String(bruta).trim();
  return TRADUCAO_CATEGORIA[chave] ?? chave;
}

/**
 * Agrupa as despesas (saídas) por categoria, separadas por status — a
 * mesma divisão que a Pluggy já mostra: "Despesas" (liquidadas) e
 * "Despesas futuras" (pendentes). Cada lista vem ordenada da maior
 * categoria para a menor, pronta para desenhar a barra proporcional.
 *
 * @param {Array<object>} movimentos
 * @returns {{ liquidado: Array<{categoria:string, valor:number}>,
 *             pendente:  Array<{categoria:string, valor:number}> }}
 */
export function resumoPorCategoria(movimentos) {
  const somas = { liquidado: new Map(), pendente: new Map() };

  (movimentos ?? []).forEach((mov) => {
    if (mov.tipo !== 'saida') return;               // categorização é sobre despesas
    const status = mov.status === 'pendente' ? 'pendente' : 'liquidado';
    const categoria = traduzirCategoria(mov.categoria);
    const mapa = somas[status];
    mapa.set(categoria, (mapa.get(categoria) ?? 0) + (mov.valor ?? 0));
  });

  const paraLista = (mapa) => [...mapa.entries()]
    .map(([categoria, valor]) => ({ categoria, valor }))
    .sort((a, b) => b.valor - a.valor);

  return { liquidado: paraLista(somas.liquidado), pendente: paraLista(somas.pendente) };
}

/* ==================================================================
   4. TRANSPORTE
   ================================================================== */

/** Usa mock quando o backend não responde — desenvolvimento sem servidor. */
let modoOffline = false;

/** fetch com prazo: backend fora do ar não pode travar a tela. */
async function buscar(caminho) {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const resposta = await fetch(`${BASE_API}${caminho}`, {
      signal: controle.signal,
      headers: { Accept: 'application/json' }
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    return await resposta.json();
  } finally {
    clearTimeout(prazo);
  }
}

/**
 * Bloco financeiro de um perfil.
 * @param {'PF'|'PJ'} perfil
 * @returns {Promise<object>} sempre na forma canônica
 */
export async function carregarFinanceiro(perfil) {
  // 1. sem backend, o que existe é o que foi importado por .OFX
  const daImportacao = () => derivarFinanceiro(movimentosDe(perfil), perfil);

  if (modoOffline) return daImportacao();

  try {
    const bruto = await buscar(`/financas/resumo?perfil=${perfil}`);
    return normalizarFinanceiro(bruto, perfil);
  } catch (erro) {
    console.info(
      `[dados] backend fora do ar (${erro.message}) — exibindo apenas o que foi importado.`
    );
    modoOffline = true;
    return daImportacao();
  }
}

/**
 * Patrimônio e investimentos de um perfil.
 * @param {'PF'|'PJ'} perfil
 * @returns {Promise<object>} sempre na forma canônica
 */
export async function carregarInvestimentos(perfil) {
  // investimento não vem em .OFX: sem backend, a carteira fica vazia
  if (modoOffline) return moldeInvestimentos(perfil);

  try {
    const bruto = await buscar(`/financas/investimentos?perfil=${perfil}`);
    return normalizarInvestimentos(bruto, perfil);
  } catch (erro) {
    console.info(`[dados] backend fora do ar (${erro.message}) — carteira vazia.`);
    modoOffline = true;
    return moldeInvestimentos(perfil);
  }
}

/**
 * Dispara a sincronização real com a Pluggy. Único caminho do frontend que
 * gasta cota — por isso ele nunca é chamado por carregamento de tela.
 * @param {'PF'|'PJ'} perfil
 */
export async function forcarSincronizacao(perfil) {
  const resposta = await fetch(`${BASE_API}/openfinance/sincronizar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ perfil, confirmar: true })
  });
  if (!resposta.ok) throw new Error(`Sincronização falhou (HTTP ${resposta.status}).`);
  return resposta.json();
}

/**
 * Envia ao backend a conta e os movimentos que acabaram de ser importados
 * por .OFX, pra persistir no Supabase de verdade (POST /financas/importar-ofx
 * -> financasRepo.js -> upsert em `contas`/`movimentos`, sem duplicar em
 * reimportação, pelo mesmo id/FITID que já dedupica aqui em memória).
 *
 * Nunca lança erro pra cima: se o backend estiver fora do ar, a importação
 * continua funcionando em memória exatamente como já funcionava — isto é
 * a TENTATIVA de também guardar de verdade, não um requisito pra usar a
 * tela. Quem chama decide o que mostrar ao usuário a partir de `ok`.
 *
 * @param {object|null} conta
 * @param {Array<object>} movimentos
 * @param {'PF'|'PJ'} perfil
 * @returns {Promise<{ ok: boolean, motivo?: string }>}
 */
export async function persistirImportacaoOfx(conta, movimentos, perfil) {
  if (modoOffline) return { ok: false, motivo: 'backend fora do ar' };

  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const resposta = await fetch(`${BASE_API}/financas/importar-ofx`, {
      method: 'POST',
      signal: controle.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perfil, conta, movimentos })
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    return { ok: true };
  } catch (erro) {
    console.info(
      `[dados] não foi possível persistir a importação no Supabase (${erro.message}) — segue só em memória.`
    );
    return { ok: false, motivo: erro.message };
  } finally {
    clearTimeout(prazo);
  }
}

/* ==================================================================
   5. IMPORTAÇÃO DE .OFX
   Caminho da PJ enquanto não há CNPJ conectado, e rede de segurança da PF
   quando o consentimento vence.
   ================================================================== */

/**
 * Lê o texto de um arquivo OFX e devolve movimentos na forma canônica.
 * O formato é SGML antigo, com tags que muitas vezes não fecham — por isso
 * a leitura é por bloco <STMTTRN>, e não por parser XML.
 *
 * @param {string} texto conteúdo bruto do arquivo
 * @returns {Array<object>} movimentos normalizados
 */
export function lerOFX(texto) {
  const blocos = texto.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];

  return blocos.map((bloco, indice) => {
    const campo = (nome) => {
      const achado = bloco.match(new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i'));
      return achado ? achado[1].trim() : null;
    };

    const valor = num(campo('TRNAMT'));
    const bruta = campo('DTPOSTED');              // 20260814120000[-3:BRT]
    const data = bruta && bruta.length >= 8
      ? `${bruta.slice(0, 4)}-${bruta.slice(4, 6)}-${bruta.slice(6, 8)}`
      : null;

    return {
      id: campo('FITID') || `ofx-${indice}`,
      data,
      descricao: campo('MEMO') || campo('NAME') || 'Sem descrição',
      valor: valor === null ? null : Math.abs(valor),
      tipo: valor !== null && valor < 0 ? 'saida' : 'entrada',
      status: 'liquidado',                        // OFX só traz o que já caiu
      origem: 'ofx'
    };
  }).filter((m) => m.data && m.valor !== null);
}

/**
 * Lê o cabeçalho do arquivo: qual conta é e qual o saldo dela.
 *
 * O bloco <BANKACCTFROM> traz o código de compensação do banco e o número
 * da conta; <LEDGERBAL><BALAMT> traz o saldo no fechamento do extrato. É o
 * que alimenta a barra de contas conectadas.
 *
 * @param {string} texto conteúdo bruto do arquivo
 * @returns {object|null}
 */
export function lerContaOFX(texto) {
  const campo = (nome, escopo = texto) => {
    const achado = escopo.match(new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i'));
    return achado ? achado[1].trim() : null;
  };

  const blocoCorrente = texto.match(/<BANKACCTFROM>[\s\S]*?<\/BANKACCTFROM>/i)?.[0];
  const blocoCredito  = texto.match(/<CCACCTFROM>[\s\S]*?<\/CCACCTFROM>/i)?.[0];
  const cabecalho = blocoCorrente ?? blocoCredito;
  if (!cabecalho) return null;

  const codigo = campo('BANKID', cabecalho);
  const numero = campo('ACCTID', cabecalho);
  if (!codigo && !numero) return null;

  const saldoBruto = texto.match(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/i)?.[0];
  const nome = bancoPorCodigo(codigo) ?? (codigo ? `Banco ${codigo}` : 'Conta importada');

  return {
    id: `${codigo ?? '000'}-${numero ?? 'sn'}`,
    nome,
    codigo,
    numero,
    saldo: num(saldoBruto ? campo('BALAMT', saldoBruto) : null),
    // <CCACCTFROM> é cartão de crédito; <BANKACCTFROM> é conta corrente —
    // essa distinção decide se a conta entra na Overview ou nas Faturas,
    // e agora também qual tipo é gravado no Supabase (coluna contas.tipo)
    tipo: blocoCredito && !blocoCorrente ? 'credito' : 'corrente',
    origem: 'ofx'
  };
}

/**
 * Lê um File do input e devolve a conta e os movimentos.
 * @param {File} arquivo
 * @returns {Promise<{ conta: object|null, movimentos: Array<object> }>}
 */
export async function importarOFX(arquivo) {
  const texto = await arquivo.text();
  const movimentos = lerOFX(texto);
  if (!movimentos.length) throw new Error('Nenhuma transação encontrada no arquivo.');
  return { conta: lerContaOFX(texto), movimentos };
}

/** Pula a tentativa de backend e vai direto ao que está em memória. */
export function pularBackend(ligar = true) {
  modoOffline = ligar;
}
