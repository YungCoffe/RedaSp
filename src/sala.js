'use strict';

const BASE = 'https://edusp-api.ip.tv';
const SED = 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken';
const ORIGIN = 'https://saladofuturo.educacao.sp.gov.br';
const FIELDS = ['id', 'nick', 'status', 'task_id', 'answers', 'duration', 'revised_request_count'];
const TIMEOUT = 20_000;
const MAX_BYTES = 3_000_000;

class SalaError extends Error {}
class AuthenticationError extends SalaError {}
class UpstreamError extends SalaError {}
class AccessError extends SalaError {}
class ProtocolError extends SalaError {}
class DraftUnavailable extends SalaError {}
class WriteOutcomeUnknown extends SalaError {}

function idOf(value) {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,19}$/.test(text)) {
    throw new ProtocolError('Identificador inválido no serviço.');
  }
  return text;
}

function secret(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
}

function intOf(value) {
  if (typeof value === 'boolean') return null;
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

const BLOCK = /<\s*\/?\s*(?:br|p|div|li|tr|h[1-6])\s*\/?\s*>/gi;
const TAG = /<[^>]+>/g;
const ENT = [['&nbsp;', ' '], ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'],
  ['&quot;', '"'], ['&#39;', "'"]];

function plain(value) {
  if (typeof value !== 'string') return null;
  let text = value.replace(BLOCK, '\n').replace(TAG, '');
  for (const [old, novo] of ENT) text = text.split(old).join(novo);
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}

const CHAR_KEY = /(char|caract|length|len|size)/i;
const MIN_KEY = /(min|minim|small)/i;
const MAX_KEY = /(max|maxim|biggest|limit)/i;
const FAIXA = /entre\s+(\d{2,6})\s+e\s+(\d{2,6})\s*(?:caracter|char|letra)/i;
const MIN_TXT = /(?:m[íi]nimo|min\.?)\s*(?:de|:)?\s*(\d{2,6})\s*(?:caracter|char|letra)/i;
const MAX_TXT = /(?:m[áa]ximo|max\.?|limite)\s*(?:de|:)?\s*(\d{2,6})\s*(?:caracter|char|letra)/i;

function limits(question) {
  let minimo = null;
  let maximo = null;
  const walk = (node, depth) => {
    if (depth > 3 || !node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) { walk(value, depth + 1); continue; }
      if (!CHAR_KEY.test(key)) continue;
      const n = intOf(value);
      if (n === null) continue;
      if (MAX_KEY.test(key) && !MIN_KEY.test(key)) maximo = maximo === null ? n : Math.max(maximo, n);
      else if (MIN_KEY.test(key) && !MAX_KEY.test(key)) minimo = minimo === null ? n : Math.min(minimo, n);
    }
  };
  walk(question, 0);
  const texto = plain(question.statement) || '';
  if (minimo === null || maximo === null) {
    const faixa = FAIXA.exec(texto);
    if (faixa) { minimo = minimo ?? Number(faixa[1]); maximo = maximo ?? Number(faixa[2]); }
  }
  if (minimo === null) { const m = MIN_TXT.exec(texto); if (m) minimo = Number(m[1]); }
  if (maximo === null) { const m = MAX_TXT.exec(texto); if (m) maximo = Number(m[1]); }
  if (minimo && maximo && minimo > maximo) [minimo, maximo] = [maximo, minimo];
  return [minimo, maximo];
}

function challenge(data) {
  if (Array.isArray(data)) return data.some(challenge);
  if (!data || typeof data !== 'object') return false;
  return Object.entries(data).some(([k, v]) => /captcha/i.test(k) || challenge(v));
}

class Jar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    const lista = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie() : [];
    for (const linha of lista) {
      const [par] = linha.split(';');
      const i = par.indexOf('=');
      if (i > 0) this.map.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  clear() { this.map.clear(); }
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new ProtocolError('Resposta externa grande demais.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

class SalaClient {
  constructor(keys) {
    this.keys = keys;
    this.jar = new Jar();
    this.token = null;
    this.nick = null;
    this.closed = false;
    this.fila = Promise.resolve();
  }

  async close() {
    this.closed = true;
    this.token = null;
    this.nick = null;
    this.jar.clear();
  }

  serial(fn) {
    const proximo = this.fila.then(fn, fn);
    this.fila = proximo.catch(() => {});
    return proximo;
  }

  requireSession() {
    if (this.closed || !this.token || !this.nick) throw new AuthenticationError('Sessão encerrada.');
  }

  headers(extra) {
    this.requireSession();
    const base = {
      'x-api-key': this.token, 'x-api-platform': 'webclient', 'x-api-realm': 'edusp',
      accept: 'application/json, text/plain, */*', 'accept-language': 'pt-BR,pt;q=0.9',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    const cookie = this.jar.header();
    if (cookie) base.cookie = cookie;
    return { ...base, ...extra };
  }

  async request(method, url, { headers = {}, json, params } = {}) {
    let alvo = url;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of params) qs.append(k, v);
      alvo += '?' + qs.toString();
    }
    const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['content-type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(alvo, init);
    } catch {
      throw new UpstreamError('Falha de conexão com o serviço externo.');
    }
    this.jar.absorb(res);
    if (res.status === 401 || res.status === 403) throw new AccessError('Acesso negado.');
    if (res.status !== 200) throw new UpstreamError('Serviço externo recusou a consulta.');
    const buf = await readCapped(res);
    return this.parse(buf);
  }

  parse(buf) {
    let data;
    try {
      data = JSON.parse(buf.toString('utf8'));
    } catch {
      try {
        data = JSON.parse(Buffer.from(buf.toString('utf8'), 'base64').toString('utf8'));
      } catch {
        throw new ProtocolError('Resposta externa inválida.');
      }
    }
    if (challenge(data)) throw new AccessError('Verificação exigida; use o fluxo oficial.');
    return data;
  }

  async login(user, senha) {
    if (!secret(user) || !secret(senha)) throw new AuthenticationError('Credenciais inválidas.');
    return this.serial(async () => {
      if (this.closed) throw new AuthenticationError('Sessão encerrada.');
      this.token = null;
      this.nick = null;
      this.jar.clear();

      let resolvida = await this.keys.get(false);
      for (let tentativa = 0; ; tentativa += 1) {
        try {
          const res = await fetch(SED, {
            method: 'POST',
            headers: {
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'x-product-name': 'SalaDoFuturo',
              'ocp-apim-subscription-key': resolvida.key,
              origin: ORIGIN, referer: ORIGIN + '/',
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            },
            body: JSON.stringify({ user, senha }),
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT),
          });
          this.jar.absorb(res);
          const buf = await readCapped(res);

          if ((res.status === 401 || res.status === 403) && resolvida.cached && tentativa === 0) {
            this.keys.invalidate();
            resolvida = await this.keys.get(true);
            continue;
          }
          if (res.status === 401 || res.status === 403) throw new AuthenticationError('Login recusado.');
          if (res.status !== 200) throw new UpstreamError('Login indisponível.');

          const dados = this.parse(buf);
          if (!dados || !secret(dados.token)) throw new AuthenticationError('Login não confirmado.');

          const segunda = await fetch(BASE + '/registration/edusp/token', {
            method: 'POST',
            headers: {
              'content-type': 'application/json', 'x-api-platform': 'webclient',
              'x-api-realm': 'edusp', origin: ORIGIN, referer: ORIGIN + '/',
            },
            body: JSON.stringify({ token: dados.token }),
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT),
          });
          this.jar.absorb(segunda);
          const corpo = await readCapped(segunda);
          if (segunda.status !== 200) throw new AuthenticationError('Login não confirmado.');
          const final = this.parse(corpo);
          if (!final || !secret(final.auth_token) || !secret(final.nick)) {
            throw new AuthenticationError('Login não confirmado.');
          }
          this.token = final.auth_token;
          this.nick = final.nick;
          return;
        } catch (erro) {
          this.token = null;
          this.nick = null;
          this.jar.clear();
          throw erro;
        }
      }
    });
  }

  async listRaw() {
    this.requireSession();
    const data = await this.request('GET', BASE + '/room/user', {
      headers: this.headers(), params: [['list_all', 'true'], ['with_cards', 'true']],
    });
    if (!data || !Array.isArray(data.rooms)) throw new ProtocolError('Lista de salas inválida.');

    const salas = new Set();
    const alvos = [];
    for (const sala of data.rooms) {
      if (!sala || !secret(sala.name)) throw new ProtocolError('Sala sem identificação.');
      if (salas.has(sala.name)) throw new ProtocolError('Salas ambíguas.');
      salas.add(sala.name);
      alvos.push(sala.name, sala.name + ':' + this.nick);
      if (!Array.isArray(sala.group_categories)) throw new ProtocolError('Categorias inválidas.');
      for (const cat of sala.group_categories) alvos.push(idOf(cat.id));
    }
    if (!salas.size) return { data: [], completa: false };

    const juntas = new Map();
    for (const [expired, filtrado, rascunho] of
      [[false, true, false], [false, true, true], [true, false, true]]) {
      const params = [['expired_only', String(expired)], ['filter_expired', String(filtrado)],
        ['limit', '100'], ['offset', '0'], ['is_exam', 'false'], ['with_answer', 'true'],
        ['is_essay', 'true'], ['with_apply_moment', 'true']];
      for (const alvo of new Set(alvos)) params.push(['publication_target', alvo]);
      if (rascunho) params.push(['answer_statuses', 'draft']);

      const page = await this.request('GET', BASE + '/tms/task/todo', {
        headers: this.headers(), params,
      });
      if (!Array.isArray(page) || page.length > 100) throw new ProtocolError('Lista inválida.');

      for (const task of page) {
        if (!task || typeof task !== 'object') throw new ProtocolError('Redação inválida.');
        const tid = idOf(task.id);
        const sala = task.publication_target;
        if (typeof sala !== 'string' || !salas.has(sala)) continue;
        const status = task.answer_status;
        if (status !== null && status !== undefined && typeof status !== 'string') {
          throw new ProtocolError('Estado inválido.');
        }
        const aid = task.answer_id === null || task.answer_id === undefined ? null : idOf(task.answer_id);
        const item = {
          id: tid, title: typeof task.title === 'string' ? task.title : null,
          status: status ?? null, answerId: aid, room: sala,
          dueDate: typeof task.expire_at === 'string' ? task.expire_at
            : (typeof task.due_date === 'string' ? task.due_date : null),
        };
        const antes = juntas.get(tid);
        if (antes) {
          if (antes.room !== sala || (aid && antes.answerId && aid !== antes.answerId)) {
            throw new ProtocolError('Vínculo ambíguo.');
          }
          if (['finished', 'submitted'].includes(status) || ['finished', 'submitted'].includes(antes.status)) {
            item.status = 'finished';
          }
          if (antes.answerId && !item.answerId) item.answerId = antes.answerId;
          if (antes.status === 'draft' && item.status === null) item.status = 'draft';
          if (!item.title) item.title = antes.title;
        }
        juntas.set(tid, item);
      }
    }
    return {
      data: [...juntas.values()].filter((x) => !['finished', 'submitted'].includes(x.status)),
      completa: false,
    };
  }

  async listEssays() {
    return this.serial(() => this.listRaw());
  }

  async getDetail(taskId) {
    return this.serial(async () => {
      this.requireSession();
      const tid = idOf(taskId);
      const atual = await this.listRaw();
      const task = atual.data.find((x) => x.id === tid);
      if (!task) throw new AccessError('Redação não encontrada entre as acessíveis.');

      const params = [['preview_mode', 'false'], ['token_code', 'null'], ['room_name', task.room]];
      if (task.answerId) {
        params.push(['answer_id', task.answerId]);
        for (const f of FIELDS) params.push(['answer_fields', f]);
      }
      const data = await this.request('GET', BASE + `/tms/task/${tid}/apply`, {
        headers: this.headers(), params,
      });
      if (!data || idOf(data.id) !== tid) throw new ProtocolError('Identidade não confirmada.');

      let rascunho = null;
      const resposta = data.answer;
      if (resposta !== null && resposta !== undefined) {
        if (!resposta || !task.answerId || idOf(resposta.id) !== task.answerId
          || idOf(resposta.task_id) !== tid || resposta.nick !== this.nick
          || resposta.status !== 'draft') {
          throw new AccessError('Propriedade ou estado do rascunho não confirmado.');
        }
        const entradas = Object.values(resposta.answers || {}).filter(
          (e) => e && e.question_type === 'essay' && e.answer && typeof e.answer === 'object');
        if (entradas.length !== 1) throw new ProtocolError('Conteúdo do rascunho ambíguo.');
        rascunho = {
          title: typeof entradas[0].answer.title === 'string' ? entradas[0].answer.title : null,
          body: typeof entradas[0].answer.body === 'string' ? entradas[0].answer.body : null,
        };
      } else if (task.answerId) {
        throw new ProtocolError('Rascunho indicado não recuperado.');
      }

      if (!Array.isArray(data.questions)) throw new ProtocolError('Questões inválidas.');
      const questoes = [];
      let essayRaw = null;
      for (const q of data.questions) {
        const qid = idOf(q.id);
        const tipo = typeof q.type === 'string' ? q.type : null;
        if (tipo === 'essay' && !essayRaw) essayRaw = q;
        questoes.push({ id: qid, type: tipo, statement: typeof q.statement === 'string' ? q.statement : null });
      }
      if (!essayRaw) throw new ProtocolError('Questão de redação não identificada.');
      const [minimo, maximo] = limits(essayRaw);

      return {
        id: tid, title: typeof data.title === 'string' ? data.title : task.title,
        description: typeof data.description === 'string' ? data.description : null,
        room: task.room, statement: plain(essayRaw.statement),
        minChars: minimo, maxChars: maximo, questions: questoes, draft: rascunho,
      };
    });
  }

  async preflight(tid, title, body) {
    const atual = await this.listRaw();
    const task = atual.data.find((x) => x.id === tid);
    if (!task) throw new AccessError('Redação não encontrada entre as acessíveis.');

    let answerId = task.answerId;
    const params = [['preview_mode', 'false'], ['token_code', 'null'], ['room_name', task.room]];
    if (answerId) {
      params.push(['answer_id', answerId]);
      for (const f of FIELDS) params.push(['answer_fields', f]);
    }
    const data = await this.request('GET', BASE + `/tms/task/${tid}/apply`, {
      headers: this.headers(), params,
    });
    if (!data || idOf(data.id) !== tid) throw new ProtocolError('Identidade não confirmada.');

    if (!Array.isArray(data.questions)) throw new ProtocolError('Questões inválidas.');
    const tipos = new Map();
    let essayRaw = null;
    for (const q of data.questions) {
      if (!q || typeof q.type !== 'string') throw new ProtocolError('Questão inválida.');
      const qid = idOf(q.id);
      if (tipos.has(qid)) throw new ProtocolError('Questões ambíguas.');
      tipos.set(qid, q.type);
      if (q.type === 'essay' && !essayRaw) essayRaw = q;
    }
    const essays = [...tipos.entries()].filter(([, t]) => t === 'essay').map(([k]) => k);
    if (essays.length !== 1 || !essayRaw) throw new ProtocolError('Questão de redação ambígua.');

    let duration = 0;
    let candidato;
    const resposta = data.answer;
    if (resposta !== null && resposta !== undefined) {
      if (!resposta || idOf(resposta.task_id) !== tid || resposta.nick !== this.nick) {
        throw new AccessError('Propriedade do rascunho não confirmada.');
      }
      if (resposta.status !== 'draft') throw new DraftUnavailable('O rascunho existente não está em draft.');
      const confirmado = idOf(resposta.id);
      if (answerId && confirmado !== answerId) throw new AccessError('Identificador divergente.');
      answerId = confirmado;
      duration = resposta.duration;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
        throw new DraftUnavailable('Duração existente não confirmada.');
      }
      if (!resposta.answers || typeof resposta.answers !== 'object') {
        throw new ProtocolError('Respostas existentes inválidas.');
      }
      for (const [chave, entrada] of Object.entries(resposta.answers)) {
        if (!entrada || idOf(chave) !== idOf(entrada.question_id) || !tipos.has(chave)
          || entrada.question_type !== tipos.get(chave)) {
          throw new ProtocolError('Vínculo de resposta não confirmado.');
        }
      }
      candidato = structuredClone(resposta.answers);
      const essay = candidato[essays[0]];
      if (!essay || typeof essay.answer !== 'object') throw new ProtocolError('Resposta não confirmada.');
    } else if (answerId) {
      throw new ProtocolError('Rascunho indicado não recuperado.');
    } else {
      candidato = { [essays[0]]: { question_id: essays[0], question_type: 'essay', answer: {} } };
    }

    candidato[essays[0]].answer = { ...(candidato[essays[0]].answer || {}), title, body };
    const [minimo, maximo] = limits(essayRaw);

    return {
      answerId, room: task.room, minChars: minimo, maxChars: maximo,
      payload: {
        status: 'draft', answers: candidato, accessed_on: 'room',
        executed_on: task.room, duration,
      },
    };
  }

  async saveDraft(taskId, title, body) {
    return this.serial(async () => {
      this.requireSession();
      const tid = idOf(taskId);
      const titulo = String(title).trim();
      const texto = String(body).trim();
      if (!titulo || !texto) throw new RangeError('Título e texto não podem estar vazios.');

      const preparado = await this.preflight(tid, titulo, texto);
      if (preparado.maxChars && texto.length > preparado.maxChars) {
        throw new RangeError(`Texto com ${texto.length} caracteres excede o máximo de ${preparado.maxChars}.`);
      }

      const url = BASE + `/tms/task/${tid}/answer` + (preparado.answerId ? '/' + preparado.answerId : '');
      const metodo = preparado.answerId ? 'PUT' : 'POST';

      let res;
      try {
        res = await fetch(url, {
          method: metodo,
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(preparado.payload),
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT),
        });
      } catch {
        throw new WriteOutcomeUnknown('A escrita pode ter ocorrido; confira antes de repetir.');
      }
      this.jar.absorb(res);
      const buf = await readCapped(res);

      if (res.status === 401 || res.status === 403) throw new AccessError('Acesso negado ao salvar.');
      if (res.status >= 500) throw new WriteOutcomeUnknown('Erro após o envio; resultado incerto.');
      if (res.status !== 200 && res.status !== 201) throw new UpstreamError('Salvamento recusado.');

      let data = {};
      try { data = JSON.parse(buf.toString('utf8')) || {}; } catch { data = {}; }
      let novo = preparado.answerId;
      try { if (data.id !== undefined && data.id !== null) novo = idOf(data.id); } catch { /* mantém */ }

      const avisos = [];
      if (preparado.minChars && texto.length < preparado.minChars) {
        avisos.push(`Texto abaixo do mínimo informado (${preparado.minChars}).`);
      }
      return {
        redacaoId: tid, rascunhoId: novo, status: data.status || 'rascunho', metodo, avisos,
      };
    });
  }
}

module.exports = {
  SalaClient, SalaError, AuthenticationError, AccessError, ProtocolError,
  UpstreamError, DraftUnavailable, WriteOutcomeUnknown,
};