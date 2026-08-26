import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Zap, Clock, MapPin, Users, Building2, Download, ArrowLeftRight,
  LogIn, LogOut, Coffee, CheckCircle2, XCircle, Pencil, Plus,
  ChevronLeft, FileSpreadsheet, AlertTriangle, Loader2, X, Ban,
  PlayCircle, Lock, KeyRound, Settings, LayoutDashboard, Trash2,
  Activity, Timer,
} from "lucide-react";
import { loadKey, saveKey, configOk } from "./storage";

/* =========================================================================
   FRAZÃO ILUMINAÇÃO & ELÉTRICA — Controle de Ponto
   Dados persistidos no Supabase (tabela kv_store), acessível por toda a equipe.
   ========================================================================= */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const DEFAULT_ADMIN_PASSWORD = "frazao2026";

const TIPOS = {
  entrada: "Entrada",
  inicio_intervalo: "Início do intervalo",
  fim_intervalo: "Fim do intervalo",
  troca_obra: "Troca de obra",
  saida: "Saída",
};
const TIPO_ICON = {
  entrada: LogIn,
  inicio_intervalo: Coffee,
  fim_intervalo: PlayCircle,
  troca_obra: ArrowLeftRight,
  saida: LogOut,
};

function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function timeStr(d = new Date()) { return d.toTimeString().slice(0, 5); }
function fmtBR(dateStr) {
  if (!dateStr) return "-";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}
function minsToHM(mins) {
  if (mins == null || isNaN(mins) || mins < 0) return "-";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h${m > 0 ? ` ${m.toString().padStart(2, "0")}min` : ""}`;
}
function diffMinutes(dateStr, t1, t2) {
  const a = new Date(`${dateStr}T${t1}:00`);
  const b = new Date(`${dateStr}T${t2}:00`);
  return (b - a) / 60000;
}

const SEED_FUNCIONARIOS = [
  { id: uid(), nome: "João Silva", status: "Ativo", pin: "1234" },
  { id: uid(), nome: "Pedro Santos", status: "Ativo", pin: "5678" },
];
const SEED_OBRAS = [
  { id: uid(), nome: "Residência João", cliente: "João Silva", endereco: "Rua X, 123", cidade: "São José do Rio Preto", status: "Ativa" },
  { id: uid(), nome: "Galpão Industrial ABC", cliente: "Empresa ABC Ltda", endereco: "Av. Brasil, 900", cidade: "São José do Rio Preto", status: "Ativa" },
];

/* ---------- Geolocation ---------- */
function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ disponivel: false }); return; }
    const timer = setTimeout(() => resolve({ disponivel: false }), 9000);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        clearTimeout(timer);
        const { latitude, longitude, accuracy } = pos.coords;
        let endereco = null;
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=16`,
            { headers: { Accept: "application/json" } }
          );
          if (r.ok) { const j = await r.json(); endereco = j.display_name || null; }
        } catch { endereco = null; }
        resolve({ disponivel: true, lat: latitude, lng: longitude, precisao: accuracy ? Math.round(accuracy) : null, endereco });
      },
      () => { clearTimeout(timer); resolve({ disponivel: false }); },
      { enableHighAccuracy: true, timeout: 8500, maximumAge: 0 }
    );
  });
}

/* ---------- State machine ---------- */
function getFuncionarioState(funcionarioId, registros) {
  const list = registros.filter((r) => r.funcionarioId === funcionarioId).sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  let status = "sem_entrada", obraId = null, obraNome = null;
  for (const r of list) {
    if (r.tipo === "entrada") { status = "trabalhando"; obraId = r.obraId; obraNome = r.obraNome; }
    else if (r.tipo === "inicio_intervalo") { status = "intervalo"; }
    else if (r.tipo === "fim_intervalo") { status = "trabalhando"; }
    else if (r.tipo === "troca_obra") { status = "trabalhando"; obraId = r.obraId; obraNome = r.obraNome; }
    else if (r.tipo === "saida") { status = "sem_entrada"; obraId = null; obraNome = null; }
  }
  return { status, obraId, obraNome };
}
function validarAcao(estado, acao) {
  const { status } = estado;
  if (acao === "entrada" && status !== "sem_entrada") return { ok: false, msg: "Você já possui uma entrada em aberto. Utilize TROCAR DE OBRA ou SAÍDA." };
  if (acao === "inicio_intervalo") {
    if (status === "sem_entrada") return { ok: false, msg: "Registre a ENTRADA antes de iniciar o intervalo." };
    if (status === "intervalo") return { ok: false, msg: "O intervalo já está em andamento." };
  }
  if (acao === "fim_intervalo" && status !== "intervalo") return { ok: false, msg: "Não há um intervalo em andamento para finalizar." };
  if (acao === "troca_obra") {
    if (status === "sem_entrada") return { ok: false, msg: "Registre a ENTRADA antes de trocar de obra." };
    if (status === "intervalo") return { ok: false, msg: "Finalize o intervalo antes de trocar de obra." };
  }
  if (acao === "saida") {
    if (status === "sem_entrada") return { ok: false, msg: "Não há entrada em aberto para registrar a saída." };
    if (status === "intervalo") return { ok: false, msg: "Finalize o intervalo antes de registrar a saída." };
  }
  return { ok: true };
}

/* ---------- Session / hours computation ---------- */
function computeSessions(registros) {
  const byFunc = {};
  registros.forEach((r) => { byFunc[r.funcionarioId] = byFunc[r.funcionarioId] || []; byFunc[r.funcionarioId].push(r); });
  const sessions = [];
  Object.values(byFunc).forEach((list) => {
    const sorted = [...list].sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
    let periodo = null;
    const novoPeriodo = (r) => ({
      id: uid(), data: r.data, funcionarioId: r.funcionarioId, funcionarioNome: r.funcionarioNome,
      obraId: r.obraId, obraNome: r.obraNome, entrada: r.horario, entradaTs: r.criadoEm,
      entradaLoc: r.localizacaoDisponivel ? { lat: r.lat, lng: r.lng, endereco: r.endereco } : null,
      intervaloInicio: null, intervaloFim: null, intervaloMin: 0, saida: null, saidaTs: null, aberta: true,
    });
    const fechar = (r) => {
      periodo.saida = r.horario; periodo.saidaTs = r.criadoEm; periodo.aberta = false;
      const brutoMin = diffMinutes(periodo.data, periodo.entrada, periodo.saida);
      periodo.minutosTrabalhados = Math.max(0, brutoMin - periodo.intervaloMin);
      sessions.push(periodo);
    };
    sorted.forEach((r) => {
      if (r.tipo === "entrada") { periodo = novoPeriodo(r); }
      else if (!periodo) { return; }
      else if (r.tipo === "inicio_intervalo") { periodo._abertoIntervalo = r.horario; periodo.intervaloInicio = r.horario; }
      else if (r.tipo === "fim_intervalo") {
        if (periodo._abertoIntervalo) { periodo.intervaloMin += diffMinutes(r.data, periodo._abertoIntervalo, r.horario); periodo._abertoIntervalo = null; }
        periodo.intervaloFim = r.horario;
      } else if (r.tipo === "troca_obra") { fechar(r); periodo = novoPeriodo(r); }
      else if (r.tipo === "saida") { fechar(r); periodo = null; }
    });
    if (periodo) {
      const nowMin = diffMinutes(periodo.data, periodo.entrada, timeStr());
      periodo.minutosTrabalhados = Math.max(0, nowMin - periodo.intervaloMin);
      sessions.push(periodo);
    }
  });
  return sessions.sort((a, b) => (a.data + a.entrada).localeCompare(b.data + b.entrada));
}

/* ---------- CSV / XLSX export ---------- */
function toCSV(rows, headers) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(";")];
  rows.forEach((r) => lines.push(headers.map((h) => esc(r[h])).join(";")));
  return lines.join("\r\n");
}
function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function exportXLSX(rows, headers, filename) {
  if (!window.XLSX) { alert("Biblioteca de Excel não carregada."); return; }
  const data = [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ""))];
  const ws = window.XLSX.utils.aoa_to_sheet(data);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Relatório");
  window.XLSX.writeFile(wb, filename);
}

/* =========================================================================
   UI PRIMITIVES
   ========================================================================= */

function RelogioAoVivo({ big }) {
  const [agora, setAgora] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={`font-mono font-black tabular-nums tracking-tight text-amber-400 ${big ? "text-4xl" : "text-lg"}`}>
      {agora.toLocaleTimeString("pt-BR")}
    </div>
  );
}

function Logo({ size = "normal" }) {
  const big = size === "big";
  return (
    <div className="flex items-center gap-2.5">
      <div className={`relative ${big ? "w-11 h-11" : "w-9 h-9"} bg-amber-400 flex items-center justify-center shrink-0`} style={{ clipPath: "polygon(0 0, 100% 0, 100% 75%, 75% 75%, 75% 100%, 0 100%)" }}>
        <Zap className={`${big ? "w-6 h-6" : "w-5 h-5"} text-slate-900`} strokeWidth={2.5} fill="currentColor" />
      </div>
      <div className="leading-none">
        <div className={`font-black tracking-tight text-white ${big ? "text-xl" : "text-base"} uppercase`}>Frazão</div>
        <div className={`text-amber-400 font-medium tracking-wide ${big ? "text-[11px]" : "text-[9px]"} uppercase`}>Iluminação &amp; Elétrica</div>
      </div>
    </div>
  );
}
function BigButton({ icon: Icon, label, color, onClick, disabled }) {
  const colors = {
    green: "bg-emerald-600 active:bg-emerald-700 disabled:bg-emerald-900/40",
    amber: "bg-amber-500 active:bg-amber-600 disabled:bg-amber-900/40",
    blue: "bg-sky-600 active:bg-sky-700 disabled:bg-sky-900/40",
    red: "bg-rose-600 active:bg-rose-700 disabled:bg-rose-900/40",
    slate: "bg-slate-700 active:bg-slate-800 disabled:bg-slate-900/40",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`w-full ${colors[color]} disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl py-4 px-5 flex items-center gap-4 shadow-lg transition active:scale-[0.98]`}>
      <div className="w-11 h-11 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
        <Icon className="w-6 h-6" strokeWidth={2.2} />
      </div>
      <span className="text-lg font-bold tracking-tight">{label}</span>
    </button>
  );
}
function Modal({ title, children, onClose, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
      <div className={`bg-white w-full ${wide ? "sm:max-w-2xl" : "sm:max-w-md"} rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-y-auto`}>
        <div className="sticky top-0 bg-white flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="font-bold text-slate-900 text-lg">{title}</h3>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-500"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
function Toast({ toast }) {
  if (!toast) return null;
  const ok = toast.type !== "error";
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] w-[92%] max-w-sm">
      <div className={`flex items-start gap-3 rounded-xl shadow-2xl px-4 py-3 border ${ok ? "bg-emerald-600 border-emerald-500" : "bg-rose-600 border-rose-500"} text-white`}>
        {ok ? <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" /> : <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />}
        <span className="text-sm font-medium leading-snug">{toast.msg}</span>
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
const inputCls = "w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-slate-900 text-base focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400";

/* =========================================================================
   EMPLOYEE (HOME) VIEW — agora com etapa de PIN
   ========================================================================= */

function TelaFuncionario({ funcionarios, obras, registros, onRegistrar, notify, goAdmin }) {
  const [funcionarioId, setFuncionarioId] = useState("");
  const [pinDigitado, setPinDigitado] = useState("");
  const [pinOk, setPinOk] = useState(false);
  const [obraSelecionada, setObraSelecionada] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [loadingGps, setLoadingGps] = useState(false);
  const [trocando, setTrocando] = useState(false);

  const ativos = funcionarios.filter((f) => f.status === "Ativo");
  const obrasAtivas = obras.filter((o) => o.status === "Ativa");
  const funcionario = ativos.find((f) => f.id === funcionarioId) || null;
  const estado = funcionarioId ? getFuncionarioState(funcionarioId, registros) : null;

  useEffect(() => { setObraSelecionada(""); setTrocando(false); setPinDigitado(""); setPinOk(false); }, [funcionarioId]);

  const acaoLabel = { entrada: "Entrada", inicio_intervalo: "Início do intervalo", fim_intervalo: "Fim do intervalo", troca_obra: "Troca de obra", saida: "Saída" };

  function confirmarPin() {
    if (!funcionario) return;
    if (!funcionario.pin) { setPinOk(true); return; } // sem PIN cadastrado, libera direto
    if (pinDigitado === funcionario.pin) { setPinOk(true); }
    else { notify("PIN incorreto.", "error"); setPinDigitado(""); }
  }

  async function executar(acao, novaObraId) {
    setConfirm(null);
    setLoadingGps(true);
    const loc = await getLocation();
    setLoadingGps(false);
    let obraId = estado?.obraId, obraNome = estado?.obraNome;
    if (acao === "entrada") { const obra = obrasAtivas.find((o) => o.id === obraSelecionada); obraId = obra?.id; obraNome = obra?.nome; }
    if (acao === "troca_obra") { const obra = obrasAtivas.find((o) => o.id === novaObraId); obraId = obra?.id; obraNome = obra?.nome; }
    const now = new Date();
    const registro = {
      id: uid(), funcionarioId: funcionario.id, funcionarioNome: funcionario.nome, obraId, obraNome, tipo: acao,
      data: todayStr(now), horario: timeStr(now), localizacaoDisponivel: loc.disponivel,
      lat: loc.lat ?? null, lng: loc.lng ?? null, precisao: loc.precisao ?? null, endereco: loc.endereco ?? null,
      criadoEm: now.toISOString(),
    };
    onRegistrar(registro);
    notify(`${acaoLabel[acao]} registrada às ${registro.horario}${!loc.disponivel ? " (localização não disponível)" : ""}.`);
    setTrocando(false);
    if (acao === "saida") { setFuncionarioId(""); setObraSelecionada(""); setPinOk(false); }
  }
  function pedirConfirmacao(acao, novaObraId) {
    const check = validarAcao(estado || { status: "sem_entrada" }, acao);
    if (!check.ok) { notify(check.msg, "error"); return; }
    if (acao === "entrada" && !obraSelecionada) { notify("Selecione a obra antes de confirmar.", "error"); return; }
    if (acao === "troca_obra" && !novaObraId) { notify("Selecione a nova obra.", "error"); return; }
    setConfirm({ acao, novaObraId });
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      <div className="bg-slate-900 px-5 pt-6 pb-8 rounded-b-3xl shadow-md">
        <Logo size="big" />
        <div className="mt-5 flex items-end justify-between gap-3">
          <div>
            <div className="text-white/50 text-xs font-bold tracking-widest uppercase">Registro de Ponto</div>
            <div className="text-white text-lg font-black tracking-tight mt-0.5 capitalize">
              {new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}
            </div>
          </div>
          <RelogioAoVivo big />
        </div>
      </div>

      <div className="flex-1 px-4 -mt-4 pb-8 max-w-md w-full mx-auto">
        <div className="bg-white rounded-2xl shadow-lg p-5 mt-2">
          <Field label="Funcionário">
            <select className={inputCls} value={funcionarioId} onChange={(e) => setFuncionarioId(e.target.value)}>
              <option value="">Selecionar funcionário</option>
              {ativos.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
            </select>
          </Field>

          {funcionario && !pinOk && (
            <Field label="PIN">
              <div className="flex items-center gap-2 mb-2 text-xs text-slate-500"><Lock className="w-3.5 h-3.5" /> Digite seu PIN de 4 dígitos para confirmar sua identidade.</div>
              <input
                type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4}
                className={inputCls + " text-center text-2xl tracking-[0.5em] font-bold"}
                value={pinDigitado}
                onChange={(e) => setPinDigitado(e.target.value.replace(/\D/g, "").slice(0, 4))}
                onKeyDown={(e) => e.key === "Enter" && confirmarPin()}
                autoFocus placeholder="••••"
              />
              <button onClick={confirmarPin} className="w-full mt-3 rounded-lg bg-slate-900 text-white font-bold py-3">Confirmar PIN</button>
            </Field>
          )}

          {funcionario && pinOk && estado?.status === "sem_entrada" && (
            <Field label="Obra">
              <select className={inputCls} value={obraSelecionada} onChange={(e) => setObraSelecionada(e.target.value)}>
                <option value="">Selecionar obra</option>
                {obrasAtivas.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
              </select>
            </Field>
          )}

          {funcionario && pinOk && estado?.status !== "sem_entrada" && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <div className="text-xs font-bold uppercase text-amber-700 tracking-wide">Obra atual</div>
              <div className="text-slate-900 font-bold text-base mt-0.5">{estado.obraNome}</div>
              {estado.status === "intervalo" && <div className="text-amber-700 text-sm font-semibold mt-1 flex items-center gap-1"><Coffee className="w-4 h-4" /> Em intervalo</div>}
            </div>
          )}

          {funcionario && pinOk && (
            <div className="text-sm text-slate-500 mb-4 flex items-start gap-2 bg-slate-50 rounded-lg px-3 py-2.5">
              <CheckCircle2 className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
              <span>Confira os dados antes de registrar. <b className="text-slate-700">{funcionario.nome}</b>{estado?.status === "sem_entrada" ? "" : ` — ${estado.obraNome}`}.</span>
            </div>
          )}
        </div>

        {funcionario && pinOk && (
          <div className="mt-4 space-y-3">
            {estado.status === "sem_entrada" && <BigButton icon={LogIn} label="ENTRADA" color="green" onClick={() => pedirConfirmacao("entrada")} disabled={loadingGps} />}
            {estado.status === "trabalhando" && !trocando && (
              <>
                <BigButton icon={Coffee} label="INÍCIO DO INTERVALO" color="amber" onClick={() => pedirConfirmacao("inicio_intervalo")} disabled={loadingGps} />
                <BigButton icon={ArrowLeftRight} label="TROCAR DE OBRA" color="blue" onClick={() => setTrocando(true)} disabled={loadingGps} />
                <BigButton icon={LogOut} label="SAÍDA" color="red" onClick={() => pedirConfirmacao("saida")} disabled={loadingGps} />
              </>
            )}
            {estado.status === "trabalhando" && trocando && (
              <div className="bg-white rounded-2xl shadow-lg p-5">
                <Field label="Nova obra">
                  <select id="novaObra" className={inputCls} defaultValue="">
                    <option value="">Selecionar obra</option>
                    {obrasAtivas.filter((o) => o.id !== estado.obraId).map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
                  </select>
                </Field>
                <div className="flex gap-3">
                  <button onClick={() => setTrocando(false)} className="flex-1 rounded-lg border border-slate-300 py-3 font-bold text-slate-600">Cancelar</button>
                  <button onClick={() => pedirConfirmacao("troca_obra", document.getElementById("novaObra").value)} className="flex-1 rounded-lg bg-sky-600 text-white py-3 font-bold">Continuar</button>
                </div>
              </div>
            )}
            {estado.status === "intervalo" && <BigButton icon={PlayCircle} label="FIM DO INTERVALO" color="amber" onClick={() => pedirConfirmacao("fim_intervalo")} disabled={loadingGps} />}
          </div>
        )}

        {loadingGps && <div className="mt-4 flex items-center justify-center gap-2 text-slate-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Obtendo localização...</div>}
      </div>

      <button onClick={goAdmin} className="text-slate-400 text-xs font-medium py-4 hover:text-slate-600 flex items-center justify-center gap-1.5 mx-auto">
        <Lock className="w-3.5 h-3.5" /> Área administrativa
      </button>

      {confirm && (
        <Modal title="Confirmar registro" onClose={() => setConfirm(null)}>
          <div className="flex items-center justify-center gap-2 bg-slate-900 rounded-xl py-4 mb-4">
            <Timer className="w-5 h-5 text-amber-400" />
            <span className="font-mono font-black text-3xl text-amber-400 tabular-nums">{timeStr()}</span>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">Funcionário</span><span className="font-bold text-slate-900">{funcionario?.nome}</span></div>
            <div className="flex justify-between border-b border-slate-100 pb-2">
              <span className="text-slate-500">Obra</span>
              <span className="font-bold text-slate-900">
                {confirm.acao === "entrada" ? obrasAtivas.find((o) => o.id === obraSelecionada)?.nome
                  : confirm.acao === "troca_obra" ? obrasAtivas.find((o) => o.id === confirm.novaObraId)?.nome
                  : estado?.obraNome}
              </span>
            </div>
            <div className="flex justify-between pb-2"><span className="text-slate-500">Ação</span><span className="font-bold text-amber-600">{acaoLabel[confirm.acao]}</span></div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={() => setConfirm(null)} className="flex-1 rounded-lg border border-slate-300 py-3 font-bold text-slate-600">Cancelar</button>
            <button onClick={() => executar(confirm.acao, confirm.novaObraId)} className="flex-1 rounded-lg bg-emerald-600 text-white py-3 font-bold">Confirmar</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* =========================================================================
   ADMIN — GATE DE SENHA
   ========================================================================= */

function GateAdmin({ config, onEnter, goHome }) {
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState(false);
  function tentar() {
    const correta = config?.adminPassword || DEFAULT_ADMIN_PASSWORD;
    if (senha === correta) { sessionStorage.setItem("ponto_admin_auth", "1"); onEnter(); }
    else { setErro(true); setSenha(""); }
  }
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center px-6">
      <Logo size="big" />
      <div className="bg-white rounded-2xl shadow-2xl p-6 mt-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-4 text-slate-800 font-bold text-lg"><KeyRound className="w-5 h-5 text-amber-500" /> Acesso administrativo</div>
        <input
          type="password" className={inputCls + (erro ? " border-rose-400" : "")} placeholder="Senha"
          value={senha} onChange={(e) => { setSenha(e.target.value); setErro(false); }}
          onKeyDown={(e) => e.key === "Enter" && tentar()} autoFocus
        />
        {erro && <div className="text-rose-600 text-xs font-semibold mt-2">Senha incorreta.</div>}
        <button onClick={tentar} className="w-full mt-4 bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold py-3 rounded-lg">Entrar</button>
        <button onClick={goHome} className="w-full mt-2 text-slate-400 text-sm font-medium py-2">Voltar</button>
      </div>
    </div>
  );
}

/* =========================================================================
   ADMIN — FUNCIONÁRIOS (agora com PIN)
   ========================================================================= */

function AbaFuncionarios({ funcionarios, setFuncionarios, registros }) {
  const [modal, setModal] = useState(null);
  const [nome, setNome] = useState("");
  const [pin, setPin] = useState("");

  function salvar() {
    if (!nome.trim()) return;
    if (pin && pin.length !== 4) return;
    if (modal.editing) {
      setFuncionarios(funcionarios.map((f) => (f.id === modal.editing.id ? { ...f, nome: nome.trim(), pin } : f)));
    } else {
      setFuncionarios([...funcionarios, { id: uid(), nome: nome.trim(), status: "Ativo", pin }]);
    }
    setModal(null); setNome(""); setPin("");
  }
  function toggleStatus(f) { setFuncionarios(funcionarios.map((x) => (x.id === f.id ? { ...x, status: x.status === "Ativo" ? "Inativo" : "Ativo" } : x))); }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-slate-800">Funcionários ({funcionarios.length})</h3>
        <button onClick={() => { setNome(""); setPin(""); setModal({}); }} className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-slate-900 text-sm font-bold px-3.5 py-2 rounded-lg"><Plus className="w-4 h-4" /> Novo</button>
      </div>
      <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
        {funcionarios.length === 0 && <div className="p-6 text-center text-slate-400 text-sm">Nenhum funcionário cadastrado.</div>}
        {funcionarios.map((f) => {
          const qtd = registros.filter((r) => r.funcionarioId === f.id).length;
          return (
            <div key={f.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-semibold text-slate-800">{f.nome}</div>
                <div className="text-xs text-slate-400">{qtd} registro(s) · {f.pin ? "PIN definido" : "sem PIN"}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold px-2 py-1 rounded-full ${f.status === "Ativo" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{f.status}</span>
                <button onClick={() => { setNome(f.nome); setPin(f.pin || ""); setModal({ editing: f }); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500"><Pencil className="w-4 h-4" /></button>
                <button onClick={() => toggleStatus(f)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">{f.status === "Ativo" ? <Ban className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}</button>
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <Modal title={modal.editing ? "Editar funcionário" : "Novo funcionário"} onClose={() => setModal(null)}>
          <Field label="Nome completo"><input className={inputCls} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex: João Silva" autoFocus /></Field>
          <Field label="PIN (4 dígitos)">
            <input
              type="text" inputMode="numeric" maxLength={4} className={inputCls}
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Ex: 1234"
            />
            <div className="text-xs text-slate-400 mt-1">Usado pelo funcionário para confirmar identidade ao bater o ponto.</div>
          </Field>
          <button onClick={salvar} className="w-full bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold py-3 rounded-lg">Salvar</button>
        </Modal>
      )}
    </div>
  );
}

/* =========================================================================
   ADMIN — OBRAS
   ========================================================================= */

function AbaObras({ obras, setObras, registros }) {
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ nome: "", cliente: "", endereco: "", cidade: "" });
  function abrirNova() { setForm({ nome: "", cliente: "", endereco: "", cidade: "" }); setModal({}); }
  function abrirEditar(o) { setForm({ nome: o.nome, cliente: o.cliente, endereco: o.endereco, cidade: o.cidade }); setModal({ editing: o }); }
  function salvar() {
    if (!form.nome.trim()) return;
    if (modal.editing) setObras(obras.map((o) => (o.id === modal.editing.id ? { ...o, ...form } : o)));
    else setObras([...obras, { id: uid(), ...form, status: "Ativa" }]);
    setModal(null);
  }
  function toggleStatus(o) { setObras(obras.map((x) => (x.id === o.id ? { ...x, status: x.status === "Ativa" ? "Encerrada" : "Ativa" } : x))); }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-slate-800">Obras ({obras.length})</h3>
        <button onClick={abrirNova} className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-slate-900 text-sm font-bold px-3.5 py-2 rounded-lg"><Plus className="w-4 h-4" /> Nova</button>
      </div>
      <div className="space-y-3">
        {obras.length === 0 && <div className="p-6 text-center text-slate-400 text-sm bg-white rounded-xl border border-slate-200">Nenhuma obra cadastrada.</div>}
        {obras.map((o) => {
          const qtd = registros.filter((r) => r.obraId === o.id).length;
          return (
            <div key={o.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold text-slate-800">{o.nome}</div>
                  <div className="text-sm text-slate-500 mt-0.5">{o.cliente}</div>
                  <div className="text-xs text-slate-400 mt-1">{o.endereco} — {o.cidade}</div>
                  <div className="text-xs text-slate-400 mt-1">{qtd} registro(s) no histórico</div>
                </div>
                <span className={`text-xs font-bold px-2 py-1 rounded-full shrink-0 ${o.status === "Ativa" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{o.status}</span>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => abrirEditar(o)} className="flex items-center gap-1 text-xs font-bold text-slate-600 border border-slate-300 px-3 py-1.5 rounded-lg"><Pencil className="w-3.5 h-3.5" /> Editar</button>
                <button onClick={() => toggleStatus(o)} className="flex items-center gap-1 text-xs font-bold text-slate-600 border border-slate-300 px-3 py-1.5 rounded-lg">{o.status === "Ativa" ? <><Ban className="w-3.5 h-3.5" /> Encerrar</> : <><CheckCircle2 className="w-3.5 h-3.5" /> Reativar</>}</button>
              </div>
            </div>
          );
        })}
      </div>
      {modal && (
        <Modal title={modal.editing ? "Editar obra" : "Nova obra"} onClose={() => setModal(null)}>
          <Field label="Nome da obra"><input className={inputCls} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} /></Field>
          <Field label="Cliente"><input className={inputCls} value={form.cliente} onChange={(e) => setForm({ ...form, cliente: e.target.value })} /></Field>
          <Field label="Endereço"><input className={inputCls} value={form.endereco} onChange={(e) => setForm({ ...form, endereco: e.target.value })} /></Field>
          <Field label="Cidade"><input className={inputCls} value={form.cidade} onChange={(e) => setForm({ ...form, cidade: e.target.value })} /></Field>
          <button onClick={salvar} className="w-full bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold py-3 rounded-lg">Salvar</button>
        </Modal>
      )}
    </div>
  );
}

/* =========================================================================
   ADMIN — PONTOS
   ========================================================================= */

function AbaPontos({ registros, setRegistros, funcionarios, obras, edicoes, setEdicoes }) {
  const [fFunc, setFFunc] = useState(""), [fObra, setFObra] = useState(""), [fTipo, setFTipo] = useState("");
  const [fIni, setFIni] = useState(""), [fFim, setFFim] = useState("");
  const [editModal, setEditModal] = useState(null);
  const [novoHorario, setNovoHorario] = useState("");
  const [motivo, setMotivo] = useState("");
  const [excluirModal, setExcluirModal] = useState(null);
  const [motivoExclusao, setMotivoExclusao] = useState("");

  const filtrados = useMemo(() => registros
    .filter((r) => !fFunc || r.funcionarioId === fFunc)
    .filter((r) => !fObra || r.obraId === fObra)
    .filter((r) => !fTipo || r.tipo === fTipo)
    .filter((r) => !fIni || r.data >= fIni)
    .filter((r) => !fFim || r.data <= fFim)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)), [registros, fFunc, fObra, fTipo, fIni, fFim]);

  function abrirEdicao(r) { setNovoHorario(r.horario); setMotivo(""); setEditModal(r); }
  function salvarEdicao() {
    if (!motivo.trim()) return;
    const original = { ...editModal };
    setRegistros(registros.map((r) => (r.id === editModal.id ? { ...r, horario: novoHorario } : r)));
    setEdicoes([...edicoes, { id: uid(), registroId: editModal.id, campo: "horario", valorOriginal: original.horario, valorNovo: novoHorario, motivo: motivo.trim(), dataAlteracao: new Date().toISOString() }]);
    setEditModal(null);
  }

  function confirmarExclusao() {
    if (!motivoExclusao.trim()) return;
    const r = excluirModal;
    setRegistros(registros.filter((x) => x.id !== r.id));
    setEdicoes([...edicoes, {
      id: uid(), registroId: r.id, campo: "exclusao",
      valorOriginal: `${TIPOS[r.tipo]} — ${r.funcionarioNome} — ${r.obraNome || "-"} — ${fmtBR(r.data)} ${r.horario}`,
      valorNovo: "Registro excluído", motivo: motivoExclusao.trim(), dataAlteracao: new Date().toISOString(),
    }]);
    setExcluirModal(null);
    setMotivoExclusao("");
  }

  return (
    <div>
      <h3 className="font-bold text-slate-800 mb-3">Registros de ponto ({filtrados.length})</h3>
      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <select className={inputCls + " text-sm"} value={fFunc} onChange={(e) => setFFunc(e.target.value)}><option value="">Todos funcionários</option>{funcionarios.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</select>
        <select className={inputCls + " text-sm"} value={fObra} onChange={(e) => setFObra(e.target.value)}><option value="">Todas obras</option>{obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}</select>
        <select className={inputCls + " text-sm"} value={fTipo} onChange={(e) => setFTipo(e.target.value)}><option value="">Todos tipos</option>{Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <input type="date" className={inputCls + " text-sm"} value={fIni} onChange={(e) => setFIni(e.target.value)} />
        <input type="date" className={inputCls + " text-sm"} value={fFim} onChange={(e) => setFFim(e.target.value)} />
      </div>
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold">
              <tr><th className="text-left px-3 py-2.5">Data</th><th className="text-left px-3 py-2.5">Funcionário</th><th className="text-left px-3 py-2.5">Obra</th><th className="text-left px-3 py-2.5">Tipo</th><th className="text-left px-3 py-2.5">Horário</th><th className="text-left px-3 py-2.5">GPS</th><th className="text-left px-3 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtrados.map((r) => {
                const Icon = TIPO_ICON[r.tipo]; const editado = edicoes.some((e) => e.registroId === r.id);
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 whitespace-nowrap">{fmtBR(r.data)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{r.funcionarioNome}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{r.obraNome || "-"}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap"><span className="flex items-center gap-1"><Icon className="w-3.5 h-3.5 text-slate-400" />{TIPOS[r.tipo]}</span></td>
                    <td className="px-3 py-2.5 whitespace-nowrap font-semibold">{r.horario}{editado && <span className="ml-1 text-amber-500" title="Editado pelo administrador">*</span>}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{r.localizacaoDisponivel ? <span className="flex items-center gap-1 text-emerald-600 text-xs font-semibold"><MapPin className="w-3.5 h-3.5" />OK</span> : <span className="flex items-center gap-1 text-slate-400 text-xs font-semibold"><MapPin className="w-3.5 h-3.5" />Indisponível</span>}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <button onClick={() => abrirEdicao(r)} className="text-slate-400 hover:text-amber-600" title="Corrigir horário"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => { setExcluirModal(r); setMotivoExclusao(""); }} className="text-slate-400 hover:text-rose-600" title="Excluir registro"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtrados.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-slate-400">Nenhum registro encontrado.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {editModal && (
        <Modal title="Corrigir registro" onClose={() => setEditModal(null)}>
          <div className="text-sm text-slate-500 mb-4">{editModal.funcionarioNome} — {TIPOS[editModal.tipo]} — {fmtBR(editModal.data)}</div>
          <Field label="Horário original"><input className={inputCls} disabled value={editModal.horario} /></Field>
          <Field label="Novo horário"><input type="time" className={inputCls} value={novoHorario} onChange={(e) => setNovoHorario(e.target.value)} /></Field>
          <Field label="Motivo da alteração (obrigatório)"><textarea className={inputCls} rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex: funcionário esqueceu de registrar no horário correto" /></Field>
          <button onClick={salvarEdicao} disabled={!motivo.trim()} className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-slate-900 font-bold py-3 rounded-lg">Salvar correção</button>
        </Modal>
      )}

      {excluirModal && (
        <Modal title="Excluir registro" onClose={() => setExcluirModal(null)}>
          <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-lg p-3 mb-4">
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
            <div className="text-sm text-rose-700">
              Esta ação não pode ser desfeita. O registro será removido dos relatórios e do cálculo de horas.
              Um histórico da exclusão fica salvo para auditoria.
            </div>
          </div>
          <div className="text-sm text-slate-500 mb-4 bg-slate-50 rounded-lg px-3 py-2.5">
            {excluirModal.funcionarioNome} — {TIPOS[excluirModal.tipo]} — {excluirModal.obraNome || "-"} — {fmtBR(excluirModal.data)} {excluirModal.horario}
          </div>
          <Field label="Motivo da exclusão (obrigatório)">
            <textarea className={inputCls} rows={3} value={motivoExclusao} onChange={(e) => setMotivoExclusao(e.target.value)} placeholder="Ex: registro duplicado por clique acidental" />
          </Field>
          <div className="flex gap-3">
            <button onClick={() => setExcluirModal(null)} className="flex-1 rounded-lg border border-slate-300 py-3 font-bold text-slate-600">Cancelar</button>
            <button onClick={confirmarExclusao} disabled={!motivoExclusao.trim()} className="flex-1 rounded-lg bg-rose-600 disabled:opacity-40 text-white py-3 font-bold">Excluir</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* =========================================================================
   ADMIN — RELATÓRIOS
   ========================================================================= */

function AbaRelatorios({ registros, funcionarios, obras }) {
  const [fFunc, setFFunc] = useState(""), [fObra, setFObra] = useState(""), [fIni, setFIni] = useState(""), [fFim, setFFim] = useState("");
  const sessions = useMemo(() => computeSessions(registros), [registros]);
  const filtradas = useMemo(() => sessions
    .filter((s) => !fFunc || s.funcionarioId === fFunc)
    .filter((s) => !fObra || s.obraId === fObra)
    .filter((s) => !fIni || s.data >= fIni)
    .filter((s) => !fFim || s.data <= fFim), [sessions, fFunc, fObra, fIni, fFim]);

  const totalMin = filtradas.reduce((a, s) => a + (s.minutosTrabalhados || 0), 0);
  const dias = new Set(filtradas.map((s) => s.funcionarioId + s.data)).size;
  const porObra = useMemo(() => { const m = {}; filtradas.forEach((s) => { m[s.obraNome] = (m[s.obraNome] || 0) + (s.minutosTrabalhados || 0); }); return Object.entries(m).sort((a, b) => b[1] - a[1]); }, [filtradas]);
  const porFuncionario = useMemo(() => { const m = {}; filtradas.forEach((s) => { m[s.funcionarioNome] = (m[s.funcionarioNome] || 0) + (s.minutosTrabalhados || 0); }); return Object.entries(m).sort((a, b) => b[1] - a[1]); }, [filtradas]);

  const rows = filtradas.slice().sort((a, b) => (b.data + b.entrada).localeCompare(a.data + a.entrada)).map((s) => ({
    Data: fmtBR(s.data), Funcionário: s.funcionarioNome, Obra: s.obraNome, Entrada: s.entrada,
    "Início Intervalo": s.intervaloInicio || "-", "Fim Intervalo": s.intervaloFim || "-",
    Saída: s.aberta ? "Em andamento" : s.saida, "Horas Trabalhadas": minsToHM(s.minutosTrabalhados),
    Localização: s.entradaLoc ? (s.entradaLoc.endereco || `${s.entradaLoc.lat?.toFixed(5)}, ${s.entradaLoc.lng?.toFixed(5)}`) : "Não disponível",
  }));
  const headers = ["Data", "Funcionário", "Obra", "Entrada", "Início Intervalo", "Fim Intervalo", "Saída", "Horas Trabalhadas", "Localização"];

  return (
    <div>
      <h3 className="font-bold text-slate-800 mb-3">Relatórios</h3>
      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select className={inputCls + " text-sm"} value={fFunc} onChange={(e) => setFFunc(e.target.value)}><option value="">Todos funcionários</option>{funcionarios.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</select>
        <select className={inputCls + " text-sm"} value={fObra} onChange={(e) => setFObra(e.target.value)}><option value="">Todas obras</option>{obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}</select>
        <input type="date" className={inputCls + " text-sm"} value={fIni} onChange={(e) => setFIni(e.target.value)} />
        <input type="date" className={inputCls + " text-sm"} value={fFim} onChange={(e) => setFFim(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="bg-slate-900 text-white rounded-xl p-4"><div className="text-xs text-white/50 font-bold uppercase">Total de horas</div><div className="text-2xl font-black mt-1">{minsToHM(totalMin)}</div></div>
        <div className="bg-white border border-slate-200 rounded-xl p-4"><div className="text-xs text-slate-400 font-bold uppercase">Dias trabalhados</div><div className="text-2xl font-black mt-1 text-slate-800">{dias}</div></div>
        <div className="bg-white border border-slate-200 rounded-xl p-4"><div className="text-xs text-slate-400 font-bold uppercase">Períodos</div><div className="text-2xl font-black mt-1 text-slate-800">{filtradas.length}</div></div>
        <div className="bg-white border border-slate-200 rounded-xl p-4"><div className="text-xs text-slate-400 font-bold uppercase">Obras envolvidas</div><div className="text-2xl font-black mt-1 text-slate-800">{porObra.length}</div></div>
      </div>
      {!fFunc && porFuncionario.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
          <div className="text-xs font-bold uppercase text-slate-400 mb-2">Horas por funcionário</div>
          {porFuncionario.map(([nome, min]) => <div key={nome} className="flex justify-between py-1.5 border-b border-slate-50 last:border-0 text-sm"><span className="text-slate-700">{nome}</span><span className="font-bold text-slate-900">{minsToHM(min)}</span></div>)}
        </div>
      )}
      {porObra.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
          <div className="text-xs font-bold uppercase text-slate-400 mb-2">Horas por obra</div>
          {porObra.map(([nome, min]) => <div key={nome} className="flex justify-between py-1.5 border-b border-slate-50 last:border-0 text-sm"><span className="text-slate-700">{nome}</span><span className="font-bold text-slate-900">{minsToHM(min)}</span></div>)}
        </div>
      )}
      <div className="flex gap-2 mb-3">
        <button onClick={() => downloadFile("\uFEFF" + toCSV(rows, headers), "relatorio_ponto.csv", "text/csv;charset=utf-8")} className="flex items-center gap-1.5 text-sm font-bold border border-slate-300 px-3.5 py-2 rounded-lg text-slate-600"><Download className="w-4 h-4" /> CSV</button>
        <button onClick={() => exportXLSX(rows, headers, "relatorio_ponto.xlsx")} className="flex items-center gap-1.5 text-sm font-bold border border-slate-300 px-3.5 py-2 rounded-lg text-slate-600"><FileSpreadsheet className="w-4 h-4" /> Excel</button>
      </div>
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold"><tr>{headers.map((h) => <th key={h} className="text-left px-3 py-2.5 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => <tr key={i} className="hover:bg-slate-50">{headers.map((h) => <td key={h} className="px-3 py-2.5 whitespace-nowrap max-w-[220px] truncate">{r[h]}</td>)}</tr>)}
              {rows.length === 0 && <tr><td colSpan={headers.length} className="text-center py-8 text-slate-400">Nenhum período no filtro selecionado.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   ADMIN — DASHBOARD
   ========================================================================= */

function AbaDashboard({ funcionarios, obras, registros, setTab }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const ativos = funcionarios.filter((f) => f.status === "Ativo");
  const obrasAtivas = obras.filter((o) => o.status === "Ativa");
  const hoje = todayStr();

  const statusAgora = ativos.map((f) => ({ funcionario: f, ...getFuncionarioState(f.id, registros) }));
  const trabalhando = statusAgora.filter((s) => s.status === "trabalhando");
  const emIntervalo = statusAgora.filter((s) => s.status === "intervalo");
  const semEntrada = statusAgora.filter((s) => s.status === "sem_entrada");

  const registrosHoje = registros.filter((r) => r.data === hoje);
  const sessionsHoje = useMemo(() => computeSessions(registros).filter((s) => s.data === hoje), [registros, hoje]);
  const minutosHoje = sessionsHoje.reduce((a, s) => a + (s.minutosTrabalhados || 0), 0);
  const semGpsHoje = registrosHoje.filter((r) => !r.localizacaoDisponivel).length;

  const recentes = registros.slice().sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)).slice(0, 8);

  function tempoDesde(iso) {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)}h ${min % 60}min`;
  }

  return (
    <div>
      <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2"><LayoutDashboard className="w-4 h-4" /> Visão geral</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-emerald-600 text-white rounded-xl p-4">
          <div className="text-xs text-white/70 font-bold uppercase">Trabalhando agora</div>
          <div className="text-3xl font-black mt-1">{trabalhando.length}</div>
        </div>
        <div className="bg-amber-500 text-white rounded-xl p-4">
          <div className="text-xs text-white/70 font-bold uppercase">Em intervalo</div>
          <div className="text-3xl font-black mt-1">{emIntervalo.length}</div>
        </div>
        <div className="bg-slate-900 text-white rounded-xl p-4">
          <div className="text-xs text-white/50 font-bold uppercase">Horas hoje</div>
          <div className="text-3xl font-black mt-1">{minsToHM(minutosHoje)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-400 font-bold uppercase">Registros hoje</div>
          <div className="text-3xl font-black mt-1 text-slate-800">{registrosHoje.length}</div>
        </div>
      </div>

      {semGpsHoje > 0 && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-sm font-semibold rounded-lg px-4 py-2.5 mb-5">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {semGpsHoje} registro(s) de hoje sem localização disponível.
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4 mb-5">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-bold uppercase text-slate-400 mb-3">Quem está no ponto agora</div>
          {statusAgora.length === 0 && <div className="text-sm text-slate-400">Nenhum funcionário ativo cadastrado.</div>}
          <div className="space-y-2">
            {[...trabalhando, ...emIntervalo].map((s) => (
              <div key={s.funcionario.id} className="flex items-center justify-between text-sm border-b border-slate-50 last:border-0 pb-2 last:pb-0">
                <div>
                  <div className="font-semibold text-slate-800">{s.funcionario.nome}</div>
                  <div className="text-xs text-slate-400">{s.obraNome}</div>
                </div>
                <span className={`text-xs font-bold px-2 py-1 rounded-full ${s.status === "trabalhando" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                  {s.status === "trabalhando" ? "Trabalhando" : "Intervalo"}
                </span>
              </div>
            ))}
            {trabalhando.length === 0 && emIntervalo.length === 0 && statusAgora.length > 0 && (
              <div className="text-sm text-slate-400">Ninguém no ponto neste momento.</div>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-bold uppercase text-slate-400 mb-3">Últimos registros</div>
          <div className="space-y-2">
            {recentes.map((r) => {
              const Icon = TIPO_ICON[r.tipo];
              return (
                <div key={r.id} className="flex items-center gap-2.5 text-sm border-b border-slate-50 last:border-0 pb-2 last:pb-0">
                  <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center shrink-0"><Icon className="w-3.5 h-3.5 text-slate-500" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-slate-800 truncate">{r.funcionarioNome} — {TIPOS[r.tipo]}</div>
                    <div className="text-xs text-slate-400 truncate">{r.obraNome || "-"} · {tempoDesde(r.criadoEm)} atrás</div>
                  </div>
                  <div className="text-xs font-bold text-slate-500 shrink-0">{r.horario}</div>
                </div>
              );
            })}
            {recentes.length === 0 && <div className="text-sm text-slate-400">Nenhum registro ainda.</div>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3 text-center">
          <div className="text-xl font-black text-slate-800">{ativos.length}</div>
          <div className="text-xs text-slate-400 font-semibold">Funcionários ativos</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3 text-center">
          <div className="text-xl font-black text-slate-800">{obrasAtivas.length}</div>
          <div className="text-xs text-slate-400 font-semibold">Obras ativas</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3 text-center">
          <div className="text-xl font-black text-slate-800">{semEntrada.length}</div>
          <div className="text-xs text-slate-400 font-semibold">Sem entrada hoje</div>
        </div>
        <button onClick={() => setTab("relatorios")} className="bg-slate-900 text-white rounded-xl p-3 text-center hover:bg-slate-800">
          <div className="text-xl font-black">→</div>
          <div className="text-xs font-semibold">Ver relatórios</div>
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   ADMIN — CONFIGURAÇÕES (trocar senha)
   ========================================================================= */

function AbaConfiguracoes({ config, setConfig, notify }) {
  const [atual, setAtual] = useState(""), [nova, setNova] = useState(""), [confirma, setConfirma] = useState("");
  function salvar() {
    const senhaAtual = config?.adminPassword || DEFAULT_ADMIN_PASSWORD;
    if (atual !== senhaAtual) { notify("Senha atual incorreta.", "error"); return; }
    if (nova.length < 4) { notify("A nova senha deve ter pelo menos 4 caracteres.", "error"); return; }
    if (nova !== confirma) { notify("A confirmação não confere com a nova senha.", "error"); return; }
    setConfig({ ...config, adminPassword: nova });
    notify("Senha administrativa atualizada.");
    setAtual(""); setNova(""); setConfirma("");
  }
  return (
    <div className="max-w-sm">
      <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2"><Settings className="w-4 h-4" /> Senha administrativa</h3>
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <Field label="Senha atual"><input type="password" className={inputCls} value={atual} onChange={(e) => setAtual(e.target.value)} /></Field>
        <Field label="Nova senha"><input type="password" className={inputCls} value={nova} onChange={(e) => setNova(e.target.value)} /></Field>
        <Field label="Confirmar nova senha"><input type="password" className={inputCls} value={confirma} onChange={(e) => setConfirma(e.target.value)} /></Field>
        <button onClick={salvar} className="w-full bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold py-3 rounded-lg">Atualizar senha</button>
      </div>
    </div>
  );
}

/* =========================================================================
   ADMIN SHELL
   ========================================================================= */

function PainelAdmin({ funcionarios, setFuncionarios, obras, setObras, registros, setRegistros, edicoes, setEdicoes, config, setConfig, notify, goHome }) {
  const [tab, setTab] = useState("dashboard");
  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "funcionarios", label: "Funcionários", icon: Users },
    { id: "obras", label: "Obras", icon: Building2 },
    { id: "pontos", label: "Pontos", icon: Clock },
    { id: "relatorios", label: "Relatórios", icon: FileSpreadsheet },
    { id: "config", label: "Configurações", icon: Settings },
  ];
  return (
    <div className="min-h-screen bg-slate-100">
      <div className="bg-slate-900 px-4 py-4 flex items-center gap-3 sticky top-0 z-10 shadow-md">
        <button onClick={goHome} className="text-white/70 hover:text-white"><ChevronLeft className="w-6 h-6" /></button>
        <Logo />
        <span className="ml-auto text-white/40 text-xs font-bold uppercase tracking-widest">Painel Administrativo</span>
      </div>
      <div className="bg-white border-b border-slate-200 sticky top-[60px] z-10 overflow-x-auto">
        <div className="flex px-2 max-w-5xl mx-auto">
          {tabs.map((t) => {
            const Icon = t.icon, active = tab === t.id;
            return <button key={t.id} onClick={() => setTab(t.id)} className={`flex items-center gap-1.5 px-4 py-3 text-sm font-bold border-b-2 whitespace-nowrap transition ${active ? "border-amber-500 text-slate-900" : "border-transparent text-slate-400"}`}><Icon className="w-4 h-4" /> {t.label}</button>;
          })}
        </div>
      </div>
      <div className="max-w-5xl mx-auto p-4">
        {tab === "dashboard" && <AbaDashboard funcionarios={funcionarios} obras={obras} registros={registros} setTab={setTab} />}
        {tab === "funcionarios" && <AbaFuncionarios funcionarios={funcionarios} setFuncionarios={setFuncionarios} registros={registros} />}
        {tab === "obras" && <AbaObras obras={obras} setObras={setObras} registros={registros} />}
        {tab === "pontos" && <AbaPontos registros={registros} setRegistros={setRegistros} funcionarios={funcionarios} obras={obras} edicoes={edicoes} setEdicoes={setEdicoes} />}
        {tab === "relatorios" && <AbaRelatorios registros={registros} funcionarios={funcionarios} obras={obras} />}
        {tab === "config" && <AbaConfiguracoes config={config} setConfig={setConfig} notify={notify} />}
      </div>
    </div>
  );
}

/* =========================================================================
   ROOT APP
   ========================================================================= */

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [tela, setTela] = useState("home"); // home | gate | admin
  const [funcionarios, _setFuncionarios] = useState([]);
  const [obras, _setObras] = useState([]);
  const [registros, _setRegistros] = useState([]);
  const [edicoes, _setEdicoes] = useState([]);
  const [config, _setConfig] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    (async () => {
      const [f, o, r, e, c] = await Promise.all([
        loadKey("funcionarios", null), loadKey("obras", null), loadKey("registros", []),
        loadKey("edicoes", []), loadKey("config", null),
      ]);
      _setFuncionarios(f ?? SEED_FUNCIONARIOS);
      _setObras(o ?? SEED_OBRAS);
      _setRegistros(r);
      _setEdicoes(e);
      _setConfig(c ?? { adminPassword: DEFAULT_ADMIN_PASSWORD });
      if (f === null) saveKey("funcionarios", SEED_FUNCIONARIOS);
      if (o === null) saveKey("obras", SEED_OBRAS);
      if (c === null) saveKey("config", { adminPassword: DEFAULT_ADMIN_PASSWORD });
      setLoaded(true);
    })();
  }, []);

  const setFuncionarios = useCallback((v) => { _setFuncionarios(v); saveKey("funcionarios", v); }, []);
  const setObras = useCallback((v) => { _setObras(v); saveKey("obras", v); }, []);
  const setRegistros = useCallback((v) => { _setRegistros(v); saveKey("registros", v); }, []);
  const setEdicoes = useCallback((v) => { _setEdicoes(v); saveKey("edicoes", v); }, []);
  const setConfig = useCallback((v) => { _setConfig(v); saveKey("config", v); }, []);

  function notify(msg, type = "success") { setToast({ msg, type }); setTimeout(() => setToast(null), 3200); }
  function registrarPonto(registro) { setRegistros([...registros, registro]); }

  function irParaAdmin() {
    if (sessionStorage.getItem("ponto_admin_auth") === "1") setTela("admin");
    else setTela("gate");
  }

  if (!configOk) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-6">
        <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <h2 className="font-bold text-slate-800 text-lg mb-2">Configuração pendente</h2>
          <p className="text-sm text-slate-500 leading-relaxed">
            As variáveis <b>VITE_SUPABASE_URL</b> e <b>VITE_SUPABASE_ANON_KEY</b> não foram
            configuradas (ou estão incorretas). Configure-as no Netlify em
            <b> Site configuration → Environment variables</b> e faça um novo deploy.
          </p>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return <div className="min-h-screen bg-slate-900 flex items-center justify-center"><Loader2 className="w-8 h-8 text-amber-400 animate-spin" /></div>;
  }

  return (
    <div className="font-sans">
      <Toast toast={toast} />
      {tela === "home" && (
        <TelaFuncionario funcionarios={funcionarios} obras={obras} registros={registros} onRegistrar={registrarPonto} notify={notify} goAdmin={irParaAdmin} />
      )}
      {tela === "gate" && (
        <GateAdmin config={config} onEnter={() => setTela("admin")} goHome={() => setTela("home")} />
      )}
      {tela === "admin" && (
        <PainelAdmin
          funcionarios={funcionarios} setFuncionarios={setFuncionarios}
          obras={obras} setObras={setObras}
          registros={registros} setRegistros={setRegistros}
          edicoes={edicoes} setEdicoes={setEdicoes}
          config={config} setConfig={setConfig}
          notify={notify}
          goHome={() => setTela("home")}
        />
      )}
    </div>
  );
}
