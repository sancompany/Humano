/**
 * SAN & CO. — backend/services/financasRepo.js
 * Camada de dados de finanças. É o ÚNICO arquivo que fala com o Supabase e
 * com a Pluggy; todo o resto do backend passa por aqui.
 *
 * A REGRA CENTRAL DESTA CAMADA
 *   Leitura  -> sempre Supabase. Barata, rápida, sem limite de chamada.
 *   Escrita  -> a importação de .OFX (sempre) e a sincronização com a
 *               Pluggy (só quando alguém pede explicitamente).
 * A Pluggy é a origem, não a fonte de consulta. Quem lê a Pluggy a cada
 * pergunta queima a cota do plano pessoal em um dia.
 *
 * ESQUEMA REAL NO SUPABASE (schema-supabase.sql — fonte da verdade)
 *   contas        id (TEXT), perfil ('PF'|'PJ'), nome, codigo, numero,
 *                 saldo (numeric), tipo ('corrente'|'credito'),
 *                 limite_total (numeric), fatura_aberta (numeric), origem
 *   movimentos    id (TEXT), conta_id -> contas.id (nullable), perfil,
 *                 data (date), descricao, valor (numeric),
 *                 tipo ('entrada'|'saida'), status, categoria, origem
 *   investimentos id (TEXT), perfil, nome, instituicao, categoria,
 *                 valor_aplicado, valor_atual, data_vencimento
 *
 * Sem tabela `conexoes` ainda — perfil PF/PJ vive direto em `contas` e
 * `movimentos`, não por trás de uma conexão. Isso é mais simples que o
 * desenho original deste arquivo (conexao -> conta -> movimento) e é o
 * que está de fato criado e testado no Supabase, então é o que vence.
 * `conexoes` volta a fazer sentido quando a Pluggy conectar de verdade —
 * é aí que o consentimento por integração passa a existir (ver
 * listarConexoes() mais abaixo, guardada com um erro claro por enquanto).
 */

import { getSupabase } from './supabaseClient.js';

const PRAZO_CONSENTIMENTO_DIAS = 365;

/** Intervalo mínimo entre duas sincronizações da mesma conexão. */
const INTERVALO_MINIMO_SYNC_MS = 15 * 60 * 1000;

const supabase = getSupabase();

/* ------------------------------------------------------------------
   LEITURAS — Supabase
------------------------------------------------------------------ */

/**
 * Contas de um perfil (correntes e cartões juntos — quem quiser só um
 * tipo, filtra depois; ver obterFaturas() para o caso de cartão).
 * @param {{ perfil: 'PF'|'PJ' }} filtros
 */
export async function listarContas({ perfil }) {
  const { data, error } = await supabase
    .from('contas')
    .select('id, nome, codigo, numero, saldo, tipo, limite_total, fatura_aberta, origem')
    .eq('perfil', perfil)
    .order('nome');

  if (error) throw new Error(`Supabase/contas: ${error.message}`);
  return data;
}

/**
 * Saldo consolidado por perfil, somando as contas correntes (cartão não
 * entra aqui — fatura_aberta é dívida, não saldo disponível).
 * @param {{ perfil: 'PF'|'PJ' }} filtros
 */
export async function obterSaldo({ perfil }) {
  const { data, error } = await supabase
    .from('contas')
    .select('saldo')
    .eq('perfil', perfil)
    .eq('tipo', 'corrente');

  if (error) throw new Error(`Supabase/contas: ${error.message}`);

  // sem nenhuma conta sincronizada devolvemos null, não zero: zero é um
  // saldo de verdade e a interface precisa distinguir os dois
  if (!data.length) return { perfil, saldo: null, contas: 0 };

  const saldo = data.reduce((soma, conta) => soma + Number(conta.saldo ?? 0), 0);
  return { perfil, saldo, contas: data.length };
}

/**
 * Movimentos de um perfil, com filtro por tipo e por período.
 *
 * LIMITAÇÃO CONHECIDA: teto de 200 linhas (mesmo teto de sempre, agora
 * documentado). Com mais que isso no perfil, quem deriva totais mensais
 * a partir daqui (ver obterResumoFinanceiro) pode ficar com um total
 * incompleto do mês mais antigo da janela. Ok para uso pessoal com
 * poucas centenas de lançamentos; revisar quando deixar de ser verdade.
 *
 * @param {{ perfil: 'PF'|'PJ', tipo?: 'entrada'|'saida', desde?: string, limite?: number }} filtros
 */
export async function listarMovimentos({ perfil, tipo, desde, limite = 20 }) {
  let consulta = supabase
    .from('movimentos')
    .select('id, conta_id, data, descricao, valor, tipo, status, categoria, origem')
    .eq('perfil', perfil)
    .order('data', { ascending: false })
    .limit(Math.min(limite, 200));

  if (tipo) consulta = consulta.eq('tipo', tipo);
  if (desde) consulta = consulta.gte('data', desde);

  const { data, error } = await consulta;
  if (error) throw new Error(`Supabase/movimentos: ${error.message}`);

  // conta_id -> contaId: o front (detalhe.js) filtra o extrato por essa
  // chave em camelCase, formato que já usa desde a versão em memória
  return data.map(({ conta_id, ...m }) => ({ ...m, contaId: conta_id }));
}

/**
 * Faturas de cartão abertas e limite disponível.
 * @param {{ perfil: 'PF'|'PJ' }} filtros
 */
export async function obterFaturas({ perfil }) {
  const { data, error } = await supabase
    .from('contas')
    .select('id, nome, fatura_aberta, limite_total')
    .eq('perfil', perfil)
    .eq('tipo', 'credito');

  if (error) throw new Error(`Supabase/contas: ${error.message}`);
  if (!data.length) {
    return { perfil, faturas_abertas: null, limite_total: null, limite_disponivel: null, cartoes: [] };
  }

  const faturasAbertas = data.reduce((s, c) => s + Number(c.fatura_aberta ?? 0), 0);
  const limiteTotal = data.reduce((s, c) => s + Number(c.limite_total ?? 0), 0);

  return {
    perfil,
    faturas_abertas: faturasAbertas,
    limite_total: limiteTotal,
    limite_disponivel: limiteTotal - faturasAbertas,
    cartoes: data
  };
}

/**
 * Ativos de investimento de um perfil. totalInvestido/liquidezImediata/
 * variacaoMes não são calculados aqui de propósito — normalizarInvestimentos()
 * no front já deriva o total a partir da soma dos ativos quando esses três
 * vêm ausentes, e inventar os outros dois sem dado real quebraria a regra
 * de nunca mostrar número que não existe.
 * @param {{ perfil: 'PF'|'PJ' }} filtros
 */
export async function listarInvestimentos({ perfil }) {
  const { data, error } = await supabase
    .from('investimentos')
    .select('id, nome, instituicao, categoria, valor_aplicado, valor_atual, data_vencimento')
    .eq('perfil', perfil)
    .order('nome');

  if (error) throw new Error(`Supabase/investimentos: ${error.message}`);
  return data;
}

/* ------------------------------------------------------------------
   DERIVAÇÃO — resumo financeiro completo (o que /financas/resumo devolve)
------------------------------------------------------------------ */

/** 'AAAA-MM' de uma data ISO — mesmo corte usado em js/dados.js#derivarFinanceiro. */
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
    .reduce((soma, m) => soma + Number(m.valor ?? 0), 0);
}

/**
 * Resumo financeiro de um perfil, na forma que normalizarFinanceiro() em
 * js/dados.js espera receber. A matemática de fluxo (mês de referência é o
 * do movimento mais recente, comparação com o mês anterior) é a MESMA de
 * derivarFinanceiro() no front — duplicada aqui de propósito: front e
 * backend são fronteiras de módulo separadas neste projeto (sem
 * js/services, sem import cruzado entre os dois lados).
 *
 * @param {{ perfil: 'PF'|'PJ' }} filtros
 */
export async function obterResumoFinanceiro({ perfil }) {
  const [contas, movimentos, faturas] = await Promise.all([
    listarContas({ perfil }),
    listarMovimentos({ perfil, limite: 200 }),
    obterFaturas({ perfil })
  ]);

  const cartoes = {
    faturasAbertas: faturas.faturas_abertas,
    limiteTotal: faturas.limite_total,
    limiteDisponivel: faturas.limite_disponivel,
    detalhes: faturas.cartoes.map((c) => ({ ...c, movimentos: [] }))
    // ^ compras/pagamentos por cartão: só a Pluggy entrega esse detalhe,
    // .OFX de cartão não separa por fatura individual — gap já conhecido
  };

  if (!movimentos.length) {
    return {
      rotulo: perfil === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física',
      origem: 'supabase',
      contas,
      fluxo: {
        entradas: { total: null, variacao: null, anterior: null, subtitulo: 'Aguardando sincronização' },
        saidas:   { total: null, variacao: null, anterior: null, subtitulo: 'Aguardando sincronização' }
      },
      cartoes,
      projecao: { d7: null, d30: null },
      extrato: []
    };
  }

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
    rotulo: perfil === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física',
    origem: 'supabase',
    contas,
    fluxo: {
      entradas: lente('entrada', 'Lançamentos persistidos no Supabase'),
      saidas: lente('saida', 'Lançamentos persistidos no Supabase')
    },
    cartoes,
    projecao: { d7: null, d30: null },   // ninguém calcula isso ainda — nem o front nem a Pluggy
    extrato: ordenados
  };
}

/* ------------------------------------------------------------------
   ESCRITA — importação de .OFX (sempre) e Pluggy (só sob comando)
------------------------------------------------------------------ */

/**
 * Grava no Supabase a conta e os movimentos que acabaram de ser importados
 * de um .OFX no front. Upsert por id em ambas as tabelas: reimportar o
 * mesmo extrato não duplica no banco, só atualiza — mesmo espírito da
 * deduplicação que já existe em memória no front (ver js/dados.js).
 *
 * @param {{ perfil: 'PF'|'PJ', conta: object|null, movimentos: Array<object> }} dados
 */
export async function gravarImportacaoOfx({ perfil, conta, movimentos }) {
  let contasGravadas = 0;

  if (conta?.id) {
    const { error } = await supabase.from('contas').upsert({
      id: conta.id,
      perfil,
      nome: conta.nome,
      codigo: conta.codigo ?? null,
      numero: conta.numero ?? null,
      saldo: conta.saldo ?? null,
      tipo: conta.tipo === 'credito' ? 'credito' : 'corrente',
      origem: conta.origem ?? 'ofx'
      // limite_total/fatura_aberta ficam de fora do upsert de propósito:
      // .OFX não traz esse dado, e não incluir a coluna preserva o que já
      // estiver lá (ex.: a Pluggy tiver escrito isso depois) em vez de
      // sobrescrever com null a cada reimportação
    }, { onConflict: 'id' });
    if (error) throw new Error(`Supabase/contas upsert: ${error.message}`);
    contasGravadas = 1;
  }

  let movimentosGravados = 0;
  if (movimentos?.length) {
    const linhas = movimentos.map((m) => ({
      id: m.id,
      conta_id: m.contaId ?? null,
      perfil,
      data: m.data,
      descricao: m.descricao,
      valor: m.valor,
      tipo: m.tipo,
      status: m.status ?? 'liquidado',
      categoria: m.categoria ?? null,
      origem: m.origem ?? 'ofx'
    }));
    const { error } = await supabase.from('movimentos').upsert(linhas, { onConflict: 'id' });
    if (error) throw new Error(`Supabase/movimentos upsert: ${error.message}`);
    movimentosGravados = linhas.length;
  }

  return { contas: contasGravadas, movimentos: movimentosGravados };
}

/**
 * Conexões bancárias (Pluggy) — GUARDADA por enquanto. A tabela `conexoes`
 * não existe no schema real ainda (ver nota no topo do arquivo); só
 * volta a fazer sentido quando a integração com a Pluggy for construída
 * de verdade. Chamar isto hoje devolve um erro claro em vez de estourar
 * um "relation does not exist" críptico do Postgres.
 */
export async function listarConexoes() {
  throw new Error(
    'listarConexoes() ainda não tem tabela — a Pluggy não está conectada de verdade. ' +
    'Ver schema-supabase.sql e a sessão combinada para essa integração.'
  );
}

/**
 * Puxa da Pluggy e grava no Supabase. É a única função do backend que sai
 * para a internet buscar dado financeiro.
 *
 * BLOQUEADA por ora pelo mesmo motivo de listarConexoes() — sem a tabela
 * `conexoes`, não há de onde ler qual conexão sincronizar. Assinatura e
 * lógica de trava de frequência/consentimento mantidas prontas.
 *
 * @param {{ conexaoId?: string, forcar?: boolean }} opcoes
 *        conexaoId ausente sincroniza todas; forcar ignora o intervalo mínimo.
 */
export async function sincronizarPluggy({ conexaoId, forcar = false } = {}) {
  const conexoes = await listarConexoes();   // lança o erro claro acima, por enquanto
  const alvos = conexaoId ? conexoes.filter((c) => c.id === conexaoId) : conexoes;

  if (!alvos.length) throw new Error('Nenhuma conexão encontrada para sincronizar.');

  const resultados = [];

  for (const conexao of alvos) {
    // trava de frequência: protege a cota do plano pessoal
    const decorrido = Date.now() - new Date(conexao.ultima_sync ?? 0).getTime();
    if (!forcar && decorrido < INTERVALO_MINIMO_SYNC_MS) {
      resultados.push({
        conexao: conexao.instituicao,
        status: 'ignorada',
        motivo: `sincronizada há menos de ${INTERVALO_MINIMO_SYNC_MS / 60000} minutos`
      });
      continue;
    }

    // consentimento vencido não adianta tentar: a Pluggy devolve vazio
    if (conexao.dias_restantes <= 0) {
      resultados.push({
        conexao: conexao.instituicao,
        status: 'bloqueada',
        motivo: 'consentimento vencido — reautorize no banco'
      });
      continue;
    }

    try {
      const coletado = await buscarNaPluggy(conexao);
      await gravarImportacaoOfx({ perfil: conexao.perfil, conta: null, movimentos: coletado.movimentos });
      // TODO: quando a tabela `conexoes` existir, atualizar ultima_sync aqui

      resultados.push({
        conexao: conexao.instituicao,
        status: 'atualizada',
        contas: coletado.contas.length,
        movimentos: coletado.movimentos.length
      });
    } catch (erro) {
      resultados.push({ conexao: conexao.instituicao, status: 'erro', motivo: erro.message });
    }
  }

  return { sincronizado_em: new Date().toISOString(), resultados };
}

/* ------------------------------------------------------------------
   AUXILIARES
------------------------------------------------------------------ */

/**
 * Dias que faltam para o consentimento vencer. Nunca negativo.
 * Não usada por enquanto (listarConexoes() está bloqueada) — mantida
 * pronta para quando a tabela `conexoes` existir de verdade.
 */
function diasRestantes(consentidoEm) {
  if (!consentidoEm) return 0;
  const decorridos = Math.floor((Date.now() - new Date(consentidoEm).getTime()) / 86_400_000);
  return Math.max(0, PRAZO_CONSENTIMENTO_DIAS - decorridos);
}

/**
 * >>> A IMPLEMENTAR quando as credenciais da Pluggy estiverem no .env <<<
 * Deve devolver { contas: [...], movimentos: [...] } já no formato das
 * tabelas descritas no topo deste arquivo. Toda a tradução do formato da
 * Pluggy para o nosso acontece aqui, e em nenhum outro lugar.
 */
async function buscarNaPluggy(conexao) {
  throw new Error(
    `Integração da Pluggy ainda não implementada (conexão ${conexao.instituicao}).`
  );
}
