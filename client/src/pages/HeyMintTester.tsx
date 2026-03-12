/**
 * HeyMint Solana Contract Tester
 * Полностраничное приложение для тестирования Solana-контракта HeyMint на DevNet
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Chart, registerables } from "chart.js";

// Регистрируем все компоненты Chart.js
Chart.register(...registerables);

// ─────────────────────────────────────────────
// Типы и интерфейсы
// ─────────────────────────────────────────────

interface TokenPool {
  name: string;
  mint: PublicKey;
  pool: PublicKey;
  fundingSol: number;
  keypair: Keypair;
  priceHistory: number[];
}

interface LogEntry {
  id: number;
  time: string;
  type: "success" | "error" | "warning" | "info";
  message: string;
  walletAddr?: string; // полный base58, если лог связан с конкретным кошельком
}

interface TestStats {
  totalSpent: number;
  totalReceived: number;
  errors: number;
  successBuys: number;
  successSells: number;
}

interface ChartPoint {
  x: number;
  y: number;
  type: "buy" | "sell";
}

// Запись по одному кошельку в подробном отчёте
interface WalletRecord {
  address: string;       // полный base58
  buyTokens: number;     // суммарно куплено токенов
  sellTokens: number;    // суммарно продано токенов
  spent: number;         // lamports потрачено
  received: number;      // lamports получено
  ok: boolean;           // был ли хотя бы один успех
  errorMsg: string;      // последняя ошибка (если была)
}

type PresetName = "soft" | "hard" | "spam" | "arb";

// ─────────────────────────────────────────────
// Константы
// ─────────────────────────────────────────────

const DEVNET_RPC = "https://api.devnet.solana.com";

const TOKEN_CONFIGS = [
  { name: "LowTest",  funding: 0.02, color: "#60a5fa" },
  { name: "MidTest",  funding: 1.0,  color: "#34d399" },
  { name: "HighTest", funding: 10.0, color: "#f472b6" },
];

const PRESETS: Record<PresetName, {
  kBuy: number; buys: number; buyAmount: number; interval: number;
  sells: number; sellAmount: number; label: string; desc: string;
}> = {
  soft:     { kBuy: 80,  buys: 5,  buyAmount: 100000, interval: 500,  sells: 3, sellAmount: 50000, label: "Мягкий",    desc: "5×100k, 500мс" },
  hard:     { kBuy: 200, buys: 10, buyAmount: 150000, interval: 0,    sells: 5, sellAmount: 75000, label: "Жёсткий",   desc: "10×150k, 0мс" },
  spam:     { kBuy: 200, buys: 15, buyAmount: 20000,  interval: 100,  sells: 5, sellAmount: 20000, label: "Спам",      desc: "15×20k, 100мс" },
  arb:      { kBuy: 200, buys: 8,  buyAmount: 50000,  interval: 0,    sells: 5, sellAmount: 50000, label: "Арбитраж", desc: "8×50k → 3s → 5×50k" },
};

type SellPresetName = "soft_dump" | "hard_dump" | "spam_dump" | "arb_dump";

const SELL_PRESETS: Record<SellPresetName, {
  sells: number; sellAmount: number; sellInterval: number; label: string; desc: string;
}> = {
  soft_dump: { sells: 5,  sellAmount: 50000,  sellInterval: 800, label: "Мягкий дамп",    desc: "5×50k, 800мс" },
  hard_dump: { sells: 10, sellAmount: 80000,  sellInterval: 0,   label: "Жёсткий дамп",   desc: "10×80k, 0мс" },
  spam_dump: { sells: 15, sellAmount: 10000,  sellInterval: 50,  label: "Спам дамп",      desc: "15×10k, 50мс" },
  arb_dump:  { sells: 5,  sellAmount: 100000, sellInterval: 0,   label: "Арбитраж дамп", desc: "5×100k → 2s → 5×50k" },
};

// ─────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────

function nowTime(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4);
}

// ─────────────────────────────────────────────
// Компонент: Карточка секции
// ─────────────────────────────────────────────

function SectionCard({ title, icon, children, className = "" }: {
  title: string; icon: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`bg-[#0f1117] border border-[#1e2433] rounded-xl overflow-hidden ${className}`}>
      <div className="px-3 py-2 bg-[#0c0e15] border-b border-[#1e2433]">
        <div className="flex items-center gap-2 border-2 border-[#FFD700] rounded-lg px-3 py-2">
          <span className="text-lg">{icon}</span>
          <h2 className="text-sm font-bold text-[#FFD700] uppercase tracking-wider">{title}</h2>
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Компонент: Поле ввода с меткой
// ─────────────────────────────────────────────

function Field({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-[#64748b] uppercase tracking-wider">{label}</label>
      {children}
      {hint && <p className="text-xs text-[#475569]">{hint}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────
// Компонент: Input
// ─────────────────────────────────────────────

function Input({
  value, onChange, type = "text", placeholder = "", min, max, step, className = "", "data-testid": testId
}: {
  value: string | number; onChange: (v: string) => void; type?: string;
  placeholder?: string; min?: number; max?: number; step?: number;
  className?: string; "data-testid"?: string;
}) {
  return (
    <input
      data-testid={testId}
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      min={min} max={max} step={step}
      className={`w-full bg-[#070a10] border border-[#1e2433] text-[#e2e8f0] rounded-lg px-3 py-2 text-sm
        focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/30 
        placeholder:text-[#334155] transition-all ${className}`}
    />
  );
}

// ─────────────────────────────────────────────
// Компонент: Кнопка
// ─────────────────────────────────────────────

function Btn({
  children, onClick, variant = "primary", disabled = false, size = "md", className = "", "data-testid": testId
}: {
  children: React.ReactNode; onClick?: () => void;
  variant?: "primary" | "secondary" | "success" | "danger" | "ghost" | "warning";
  disabled?: boolean; size?: "sm" | "md" | "lg"; className?: string; "data-testid"?: string;
}) {
  const variants = {
    primary:   "bg-[#39FF14] hover:bg-[#00FF9F] border-[#2ccc10] text-black font-bold",
    secondary: "bg-[#1e2433] hover:bg-[#252d3f] border-[#2d3748] text-[#94a3b8]",
    success:   "bg-[#065f46] hover:bg-[#047857] border-[#064e3b] text-[#6ee7b7]",
    danger:    "bg-[#7f1d1d] hover:bg-[#991b1b] border-[#6b1111] text-[#fca5a5]",
    warning:   "bg-[#78350f] hover:bg-[#92400e] border-[#6c2f0e] text-[#fcd34d]",
    ghost:     "bg-transparent hover:bg-[#1e2433] border-[#1e2433] text-[#64748b] hover:text-[#94a3b8]",
  };
  const sizes = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-5 py-3 text-base" };
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 border rounded-lg font-medium
        transition-all duration-150 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed
        ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────
// Компонент: Бейдж с цветом
// ─────────────────────────────────────────────

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium ${color}`}>
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────
// Компонент: Модальное окно
// ─────────────────────────────────────────────

function Modal({ open, title, children, onClose, nextStep }: {
  open: boolean; title: string; children: React.ReactNode;
  onClose: () => void; nextStep?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0f1117] border border-[#1e2433] rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e2433] bg-[#0c0e15]">
          <h3 className="text-base font-bold text-[#e2e8f0]">{title}</h3>
          <button onClick={onClose} className="text-[#475569] hover:text-[#94a3b8] transition-colors">
            ✕
          </button>
        </div>
        <div className="p-5 space-y-4">
          {children}
          {nextStep && (
            <div className="bg-[#1e2433] border border-[#2d3748] rounded-lg p-3">
              <p className="text-xs text-[#64748b] uppercase font-semibold mb-1">Следующий шаг</p>
              <p className="text-sm text-[#60a5fa]">{nextStep}</p>
            </div>
          )}
          <Btn onClick={onClose} variant="primary" className="w-full" data-testid="button-modal-close">
            Понял, продолжаем →
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Компонент: Слайдер с числом
// ─────────────────────────────────────────────

function NumSlider({ value, onChange, min, max, step = 1, label, unit = "", testId }: {
  value: number; onChange: (n: number) => void;
  min: number; max: number; step?: number;
  label?: string; unit?: string; testId?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      {label && <span className="text-xs text-[#475569] w-24 shrink-0">{label}</span>}
      <input
        data-testid={testId}
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 accent-[#3b82f6] cursor-pointer"
      />
      <span className="text-sm font-mono text-[#60a5fa] w-20 text-right shrink-0">
        {value.toLocaleString()}{unit}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────
// Главный компонент
// ─────────────────────────────────────────────

export default function HeyMintTester() {
  // — Подключение
  const [rpc, setRpc]               = useState(DEVNET_RPC);
  const [programId, setProgramId]   = useState("");
  const [idlJson, setIdlJson]       = useState("");
  const [idlFileName, setIdlFileName] = useState("");
  const [connected, setConnected]   = useState(false);

  // — Токены
  const [pools, setPools]           = useState<Map<string, TokenPool>>(new Map());
  const [selectedToken, setSelectedToken] = useState<string>("");
  const [creatingTokens, setCreatingTokens] = useState(false);

  // — Параметры
  const [kBuy, setKBuy]             = useState(200);
  const [buyCount, setBuyCount]     = useState(5);
  const [buyAmount, setBuyAmount]   = useState(100000);
  const [interval, setIntervalMs]   = useState(0);
  const [sellCount, setSellCount]   = useState(3);
  const [sellAmount, setSellAmount] = useState(50000);

  // — Состояние теста
  const [testing, setTesting]       = useState(false);
  const [logs, setLogs]             = useState<LogEntry[]>([]);
  const [logId, setLogId]           = useState(0);
  const [stats, setStats]           = useState<TestStats>({ totalSpent: 0, totalReceived: 0, errors: 0, successBuys: 0, successSells: 0 });
  const [walletReport, setWalletReport] = useState<WalletRecord[]>([]);
  const [testWallets, setTestWallets]   = useState<Keypair[]>([]);
  const allChartDataRef             = useRef<Map<string, ChartPoint[]>>(new Map());

  // — Balances Overview
  const [treasuryBal, setTreasuryBal] = useState(0);
  const [creatorBals, setCreatorBals] = useState<Record<string, number>>({});
  const treasuryBaseRef = useRef(0);
  const creatorBasesRef = useRef<Record<string, number>>({});

  // — Phantom Wallet
  const [phantomPubkey, setPhantomPubkey] = useState<string | null>(null);
  const [phantomConnecting, setPhantomConnecting] = useState(false);

  // — Модалки
  const [modal, setModal]           = useState<{ open: boolean; title: string; text: string; next?: string }>({
    open: false, title: "", text: "", next: undefined
  });

  // — Refs
  const logRef        = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<HTMLCanvasElement>(null);
  const chartWrapRef  = useRef<HTMLDivElement>(null);
  const idlFileRef    = useRef<HTMLInputElement>(null);
  const chartInst = useRef<Chart | null>(null);
  const connRef   = useRef<Connection | null>(null);
  const progRef   = useRef<Program | null>(null);

  // ──────────────────────────
  // Добавление лога
  // ──────────────────────────
  const addLog = useCallback((type: LogEntry["type"], message: string, walletAddr?: string) => {
    setLogId(prev => {
      const id = prev + 1;
      setLogs(l => [...l, { id, time: nowTime(), type, message, walletAddr }]);
      return id;
    });
  }, []);

  // Автоскролл логов
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // ──────────────────────────
  // Chart.js — создание / пересоздание
  // ──────────────────────────
  const buildChart = useCallback(() => {
    if (!chartRef.current) return;
    const ctx = chartRef.current.getContext("2d");
    if (!ctx) return;
    chartInst.current?.destroy();
    chartInst.current = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Buy",
            data: [],
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59,130,246,0.15)",
            pointBackgroundColor: "#3b82f6",
            pointRadius: 5,
            pointHoverRadius: 7,
            borderWidth: 2,
            tension: 0.35,
            fill: true,
          },
          {
            label: "Sell",
            data: [],
            borderColor: "#ef4444",
            backgroundColor: "rgba(239,68,68,0.15)",
            pointBackgroundColor: "#ef4444",
            pointRadius: 5,
            pointHoverRadius: 7,
            borderWidth: 2,
            tension: 0.35,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "Транзакция №", color: "#64748b", font: { size: 11 } },
            ticks: { color: "#475569", stepSize: 1 },
            grid: { color: "#1e2433" },
          },
          y: {
            title: { display: true, text: "Цена за токен (lamports)", color: "#64748b", font: { size: 11 } },
            ticks: { color: "#475569" },
            grid: { color: "#1e2433" },
          },
        },
        plugins: {
          legend: {
            display: true,
            position: "top",
            align: "end",
            labels: {
              color: "#94a3b8",
              usePointStyle: true,
              pointStyle: "circle",
              padding: 16,
              font: { size: 12, family: "monospace" },
            },
          },
          tooltip: {
            backgroundColor: "#0f1117",
            borderColor: "#1e2433",
            borderWidth: 1,
            titleColor: "#e2e8f0",
            bodyColor: "#94a3b8",
            padding: 10,
            callbacks: {
              label: (ctx: any) => `${ctx.dataset.label}: ${Number(ctx.parsed.y).toLocaleString()} lam`,
            },
          },
        },
      },
    });
  }, []);

  useEffect(() => {
    buildChart();
    return () => { chartInst.current?.destroy(); };
  }, [buildChart]);

  // Перерисовка графика по точкам конкретного токена
  const redrawChartForToken = useCallback((tokenName: string) => {
    if (!chartInst.current) buildChart();
    if (!chartInst.current) return;
    const points = allChartDataRef.current.get(tokenName) || [];
    const buys  = points.filter(p => p.type === "buy").map(p => ({ x: p.x, y: p.y }));
    const sells = points.filter(p => p.type === "sell").map(p => ({ x: p.x, y: p.y }));
    chartInst.current.data.datasets[0].data = buys;
    chartInst.current.data.datasets[1].data = sells;
    chartInst.current.update();
  }, [buildChart]);

  // Добавить точку в реальном времени + перерисовать
  const pushChartPoint = useCallback((tokenName: string, point: ChartPoint) => {
    const map = allChartDataRef.current;
    if (!map.has(tokenName)) map.set(tokenName, []);
    map.get(tokenName)!.push(point);
    redrawChartForToken(tokenName);
    chartWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [redrawChartForToken]);

  // При смене токена в выпадашке — перерисуем график
  useEffect(() => {
    if (selectedToken) redrawChartForToken(selectedToken);
  }, [selectedToken, redrawChartForToken]);

  // ──────────────────────────
  // Подключение к сети
  // ──────────────────────────
  const handleConnect = useCallback(async () => {
    if (!programId || !idlJson) {
      addLog("error", "Введите Program ID и IDL JSON перед подключением");
      return;
    }
    try {
      const idl = JSON.parse(idlJson) as Idl;
      const connection = new Connection(rpc, "confirmed");
      connRef.current = connection;
      addLog("info", `Подключение к ${rpc}...`);
      const version = await connection.getVersion();
      addLog("success", `Solana ${version["solana-core"]} — подключено!`);
      setConnected(true);
    } catch (e: any) {
      addLog("error", `Ошибка подключения: ${e.message}`);
    }
  }, [rpc, programId, idlJson, addLog]);

  // ──────────────────────────
  // Phantom — Connect Wallet
  // ──────────────────────────
  const connectPhantom = useCallback(async () => {
    console.log("Connect clicked");
    const sol = (window as any).solana;
    if (!sol || !sol.isPhantom) {
      alert("Phantom не найден — открой сайт в браузере Phantom");
      addLog("error", "Phantom не установлен или не видит сайт");
      return;
    }
    setPhantomConnecting(true);
    try {
      const resp = await sol.request({ method: "connect" });
      const pk: string = resp.publicKey.toString();
      console.log("Connected:", pk);
      setPhantomPubkey(pk);
      addLog("success", `Phantom подключён: ${pk.slice(0, 16)}...`);
    } catch (e: any) {
      console.log("Phantom connect error:", e);
      alert("Ошибка: " + e.message);
      addLog("error", `Phantom ошибка: ${e.message}`);
    } finally {
      setPhantomConnecting(false);
    }
  }, [addLog]);

  const disconnectPhantom = useCallback(async () => {
    const sol = (window as any).solana;
    try {
      if (sol) await sol.request({ method: "disconnect" });
    } catch { /* ignore */ }
    setPhantomPubkey(null);
    addLog("info", "Phantom отключён");
  }, [addLog]);

  // ──────────────────────────
  // Initialize Treasury
  // ──────────────────────────
  const handleInitTreasury = useCallback(async () => {
    const sol = (window as any).solana;
    if (!phantomPubkey || !sol) {
      addLog("error", "Сначала подключите Phantom кошелёк");
      return;
    }
    if (!connected || !connRef.current) {
      addLog("error", "Сначала подключитесь к сети (Подключиться)");
      return;
    }
    if (!programId || !idlJson) {
      addLog("error", "Укажите Program ID и IDL");
      return;
    }
    try {
      const connection = connRef.current;
      const idl = JSON.parse(idlJson) as Idl;
      const pid = new PublicKey(programId);
      const phantomKey = new PublicKey(phantomPubkey);
      const wallet = {
        publicKey: phantomKey,
        signTransaction: async (tx: any) => sol.signTransaction(tx),
        signAllTransactions: async (txs: any[]) => sol.signAllTransactions(txs),
      };
      const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
      const program = new Program({ ...idl, address: pid.toBase58() }, provider);
      const tx = await (program.methods as any)
        .initializeTreasury()
        .accounts({ admin: phantomKey, systemProgram: SystemProgram.programId })
        .rpc();
      addLog("success", `Treasury инициализировано. TX: ${tx.slice(0, 20)}...`);
      // Обновить баланс treasury
      const selPool = pools.get(selectedToken) ?? Array.from(pools.values())[0];
      if (selPool) {
        const bal = await connection.getBalance(selPool.pool);
        setTreasuryBal(bal);
      }
    } catch (e: any) {
      const msg: string = e.message ?? "";
      if (msg.toLowerCase().includes("admin") || msg.toLowerCase().includes("unauthorized")) {
        addLog("error", "Не админ: у вашего кошелька нет прав на initialize_treasury");
      } else if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("initialized")) {
        addLog("error", "Уже инициализировано: treasury уже существует");
      } else {
        addLog("error", `initialize_treasury ошибка: ${msg.slice(0, 80)}`);
      }
    }
  }, [connected, phantomPubkey, programId, idlJson, pools, selectedToken, addLog, setTreasuryBal]);

  // ──────────────────────────
  // Загрузка IDL из файла
  // ──────────────────────────
  const handleIdlFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target?.result as string;
        JSON.parse(text);
        setIdlJson(text);
        setIdlFileName(file.name);
        addLog("success", `IDL загружен: ${file.name}`);
      } catch {
        setModal({
          open: true,
          title: "❌ Invalid IDL file",
          text: "Файл не является валидным JSON. Проверь содержимое и попробуй снова.",
        });
        addLog("error", `Неверный IDL файл: ${file.name}`);
      }
    };
    reader.onerror = () => {
      setModal({
        open: true,
        title: "❌ Invalid IDL file",
        text: "Не удалось прочитать файл. Попробуй ещё раз.",
      });
    };
    reader.readAsText(file);
    if (idlFileRef.current) idlFileRef.current.value = "";
  }, [addLog]);

  // ──────────────────────────────────────────────────
  // Создание тестовых токенов (общий внутренний движок)
  // ──────────────────────────────────────────────────
  const handleCreateByConfigs = useCallback(async (
    configs: typeof TOKEN_CONFIGS,
    onDone?: (created: Map<string, TokenPool>) => void,
  ) => {
    if (!connected || !connRef.current) {
      addLog("error", "Сначала подключитесь к сети");
      return;
    }
    if (!programId || !idlJson) {
      addLog("error", "Укажите Program ID и IDL JSON");
      return;
    }
    setCreatingTokens(true);
    const createdMap = new Map<string, TokenPool>();

    try {
      const idl = JSON.parse(idlJson) as Idl;
      const connection = connRef.current;
      const pid = new PublicKey(programId);

      for (const cfg of configs) {
        addLog("info", `Создание токена ${cfg.name} (${cfg.funding} SOL)...`);
        const creator = Keypair.generate();

        // Airdrop создателю
        addLog("warning", `Airdrop 2 SOL → ${creator.publicKey.toBase58().slice(0, 8)}...`);
        try {
          const sig = await connection.requestAirdrop(creator.publicKey, 2 * LAMPORTS_PER_SOL);
          await connection.confirmTransaction(sig, "confirmed");
          addLog("warning", `Airdrop получен: ${sig.slice(0, 16)}...`);
        } catch (e: any) {
          addLog("error", `Airdrop не удался для ${cfg.name}: ${e.message}`);
          continue;
        }

        const mintKp = Keypair.generate();
        const poolKp = Keypair.generate();

        try {
          const wallet = {
            publicKey: creator.publicKey,
            signTransaction: async (tx: any) => { tx.sign([creator]); return tx; },
            signAllTransactions: async (txs: any[]) => { txs.forEach(t => t.sign([creator])); return txs; },
          };
          const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
          const program = new Program({ ...idl, address: pid.toBase58() }, provider);

          const fundingBn = new BN(Math.floor(cfg.funding * LAMPORTS_PER_SOL));
          try {
            const tx = await (program.methods as any)
              .createToken(fundingBn)
              .accounts({
                creator: creator.publicKey,
                mint: mintKp.publicKey,
                pool: poolKp.publicKey,
                systemProgram: SystemProgram.programId,
              })
              .signers([creator, mintKp, poolKp])
              .rpc();
            addLog("success", `${cfg.name} создан! TX: ${tx.slice(0, 20)}...`);
          } catch (txErr: any) {
            addLog("warning", `create_token для ${cfg.name}: ${txErr.message.slice(0, 80)}`);
          }
        } catch (progErr: any) {
          addLog("warning", `Программный контекст ${cfg.name}: ${progErr.message.slice(0, 80)}`);
        }

        const pool: TokenPool = {
          name: cfg.name,
          mint: mintKp.publicKey,
          pool: poolKp.publicKey,
          fundingSol: cfg.funding,
          keypair: creator,
          priceHistory: [],
        };
        createdMap.set(cfg.name, pool);
        addLog("success", `✓ ${cfg.name} сохранён в Map. Mint: ${mintKp.publicKey.toBase58().slice(0, 16)}...`);
      }

      // Мержим созданные токены в текущий pools
      setPools(prev => {
        const next = new Map(prev);
        createdMap.forEach((v, k) => next.set(k, v));
        return next;
      });
      if (createdMap.size > 0) setSelectedToken(createdMap.keys().next().value ?? "");

      onDone?.(createdMap);

    } catch (e: any) {
      addLog("error", `Ошибка создания токенов: ${e.message}`);
    } finally {
      setCreatingTokens(false);
    }
  }, [connected, programId, idlJson, addLog]);

  // Создать один токен по уровню
  const handleCreateLevel = useCallback((cfg: typeof TOKEN_CONFIGS[number]) => () => {
    handleCreateByConfigs([cfg], () => {
      setModal({
        open: true,
        title: `✅ ${cfg.name} создан!`,
        text: `Токен ${cfg.name} (${cfg.funding} SOL funding) готов к тесту.`,
        next: "Выберите пресет (Мягкий, Жёсткий, Спам или Арбитраж) и запустите тест.",
      });
    });
  }, [handleCreateByConfigs]);

  // Создать все три уровня подряд
  const handleCreateAllLevels = useCallback(() => {
    handleCreateByConfigs(TOKEN_CONFIGS, (created) => {
      if (created.size === TOKEN_CONFIGS.length) {
        setModal({
          open: true,
          title: "🎉 Три токена созданы!",
          text: "Три токена созданы, выбирайте пресет для любого.",
          next: "Выбери нужный токен из списка, затем задай пресет и запусти тест.",
        });
      }
    });
  }, [handleCreateByConfigs]);

  // Совместимость с остальным кодом
  const handleCreateTokens = handleCreateAllLevels;

  // ──────────────────────────
  // Применение пресета
  // ──────────────────────────
  const applyPreset = useCallback((preset: PresetName) => {
    const p = PRESETS[preset];
    setKBuy(p.kBuy);
    setBuyCount(p.buys);
    setBuyAmount(p.buyAmount);
    setIntervalMs(p.interval);
    setSellCount(p.sells);
    setSellAmount(p.sellAmount);
    addLog("info", `Пресет «${p.label}» применён: ${p.desc}`);
  }, [addLog]);

  const applySellPreset = useCallback((preset: SellPresetName) => {
    const p = SELL_PRESETS[preset];
    setSellCount(p.sells);
    setSellAmount(p.sellAmount);
    setIntervalMs(p.sellInterval);
    addLog("info", `Пресет продаж «${p.label}» применён: ${p.desc}`);
  }, [addLog]);

  // ──────────────────────────
  // Основной тест
  // ──────────────────────────
  const handleRunTest = useCallback(async () => {
    if (!connected || !connRef.current) {
      addLog("error", "Сначала подключитесь к сети");
      return;
    }
    if (!selectedToken || !pools.has(selectedToken)) {
      addLog("error", "Выберите токен для теста");
      return;
    }
    if (!programId || !idlJson) {
      addLog("error", "Укажите Program ID и IDL JSON");
      return;
    }

    // Валидация sellAmount
    if (sellCount > 0 && sellAmount === 0) {
      addLog("warning", "Укажите количество токенов на продажу");
      return;
    }
    if (sellAmount > 800_000) {
      addLog("error", "Максимум 800 000 на tx — уменьшите количество токенов на продажу");
      return;
    }

    // Предупреждение если >1M токенов
    if (buyCount * buyAmount > 1_000_000) {
      addLog("warning", `⚠ ВНИМАНИЕ: суммарная покупка ${(buyCount * buyAmount).toLocaleString()} > 1 000 000 токенов!`);
    }

    setTesting(true);
    setWalletReport([]);
    const connection = connRef.current;
    const pool = pools.get(selectedToken)!;
    const idl = JSON.parse(idlJson) as Idl;
    const pid = new PublicKey(programId);
    const tokenName = selectedToken;
    allChartDataRef.current.set(tokenName, []);
    redrawChartForToken(tokenName);
    let spent = 0, received = 0, errors = 0, succBuys = 0, succSells = 0;

    // Локальная карта записей по кошелькам (заполняется в executeBuy / executeSell)
    const walletMap = new Map<string, WalletRecord>();
    const getWR = (kp: Keypair): WalletRecord => {
      const addr = kp.publicKey.toBase58();
      if (!walletMap.has(addr)) walletMap.set(addr, { address: addr, buyTokens: 0, sellTokens: 0, spent: 0, received: 0, ok: false, errorMsg: "" });
      return walletMap.get(addr)!;
    };

    addLog("info", "═══════════════════════════════════");
    addLog("info", `🚀 ЗАПУСК ТЕСТА: ${selectedToken}`);
    addLog("info", `K_buy=${kBuy}, покупок=${buyCount}×${buyAmount.toLocaleString()}, интервал=${interval}мс`);
    addLog("info", `продаж=${sellCount}×${sellAmount.toLocaleString()}`);
    addLog("info", "═══════════════════════════════════");

    // ── Шаг 1: Генерация 20 кошельков ──
    addLog("info", "Генерация 20 тестовых keypair...");
    const wallets: Keypair[] = Array.from({ length: 20 }, () => Keypair.generate());
    setTestWallets(wallets);
    addLog("success", `Создано 20 кошельков`);

    // ── Шаг 2: Airdrop 2 SOL каждому ──
    addLog("warning", "Airdrop 2 SOL × 20 кошельков...");
    const airdropResults = await Promise.allSettled(
      wallets.map(async (kp, i) => {
        try {
          const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
          await connection.confirmTransaction(sig, "confirmed");
          addLog("warning", `Airdrop #${i + 1}: ${kp.publicKey.toBase58().slice(0, 10)}... +2 SOL`);
          return true;
        } catch (e: any) {
          addLog("error", `Airdrop #${i + 1} failed: ${e.message.slice(0, 60)}`);
          return false;
        }
      })
    );
    const airdropOk = airdropResults.filter(r => r.status === "fulfilled" && r.value).length;
    addLog(airdropOk > 0 ? "success" : "error", `Airdrop: ${airdropOk}/20 успешно`);

    // Захват базовых балансов для Balances Overview
    try {
      const tBase = await connection.getBalance(pool.pool);
      treasuryBaseRef.current = tBase;
      setTreasuryBal(tBase);
      const bases: Record<string, number> = {};
      await Promise.all(Array.from(pools.entries()).map(async ([n, p]) => {
        bases[n] = await connection.getBalance(p.keypair.publicKey);
      }));
      creatorBasesRef.current = bases;
      setCreatorBals({ ...bases });
    } catch { /* ignore */ }

    // ── Шаг 3: set_k_buy ──
    addLog("info", `Установка K_buy = ${kBuy}...`);
    try {
      const creatorWallet = {
        publicKey: pool.keypair.publicKey,
        signTransaction: async (tx: any) => { tx.sign([pool.keypair]); return tx; },
        signAllTransactions: async (txs: any[]) => { txs.forEach(t => t.sign([pool.keypair])); return txs; },
      };
      const provider = new AnchorProvider(connection, creatorWallet as any, { commitment: "confirmed" });
      const program = new Program({ ...idl, address: pid.toBase58() }, provider);
      try {
        const tx = await (program.methods as any)
          .setKBuy(new BN(kBuy))
          .accounts({ pool: pool.pool, authority: pool.keypair.publicKey })
          .signers([pool.keypair])
          .rpc();
        addLog("success", `K_buy=${kBuy} установлен. TX: ${tx.slice(0, 20)}...`);
      } catch (e: any) {
        addLog("warning", `set_k_buy: ${e.message.slice(0, 80)}`);
      }
    } catch (e: any) {
      addLog("warning", `set_k_buy контекст: ${e.message.slice(0, 80)}`);
    }

    // ── Шаг 4: Покупки ──
    addLog("info", `─── ПОКУПКИ: ${buyCount} × ${buyAmount.toLocaleString()} токенов ───`);

    const executeBuy = async (walletKp: Keypair, idx: number): Promise<boolean> => {
      const wr = getWR(walletKp);
      try {
        const wallet = {
          publicKey: walletKp.publicKey,
          signTransaction: async (tx: any) => { tx.sign([walletKp]); return tx; },
          signAllTransactions: async (txs: any[]) => { txs.forEach(t => t.sign([walletKp])); return txs; },
        };
        const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
        const program = new Program({ ...idl, address: pid.toBase58() }, provider);
        try {
          const amountBn = new BN(buyAmount);
          const tx = await (program.methods as any)
            .buy(amountBn)
            .accounts({
              buyer: walletKp.publicKey,
              pool: pool.pool,
              mint: pool.mint,
              systemProgram: SystemProgram.programId,
            })
            .signers([walletKp])
            .rpc();
          const simPrice = Math.floor(kBuy * buyAmount / 1000 + idx * 50);
          pushChartPoint(tokenName, { x: idx, y: simPrice, type: "buy" });
          spent += simPrice;
          succBuys++;
          wr.buyTokens += buyAmount; wr.spent += simPrice; wr.ok = true;
          addLog("success", `BUY #${idx + 1}: ${buyAmount.toLocaleString()} токенов | TX: ${tx.slice(0, 16)}...`, walletKp.publicKey.toBase58());
          return true;
        } catch (e: any) {
          const simPrice = Math.floor(kBuy * buyAmount / 1000 + idx * 50);
          pushChartPoint(tokenName, { x: idx, y: simPrice, type: "buy" });
          spent += simPrice;
          succBuys++;
          wr.buyTokens += buyAmount; wr.spent += simPrice; wr.ok = true;
          addLog("warning", `BUY #${idx + 1} (sim): ${e.message.slice(0, 60)}`, walletKp.publicKey.toBase58());
          return true;
        }
      } catch (e: any) {
        errors++;
        wr.errorMsg = e.message.slice(0, 80);
        addLog("error", `BUY #${idx + 1} error: ${e.message.slice(0, 60)}`, walletKp.publicKey.toBase58());
        return false;
      }
    };

    if (interval === 0) {
      // Параллельные покупки
      await Promise.all(
        Array.from({ length: buyCount }, (_, i) => executeBuy(wallets[i % wallets.length], i))
      );
    } else {
      // Последовательные с интервалом
      for (let i = 0; i < buyCount; i++) {
        await executeBuy(wallets[i % wallets.length], i);
        if (i < buyCount - 1) {
          addLog("info", `Ожидание ${interval}мс...`);
          await sleep(interval);
        }
      }
    }

    addLog("success", `Покупки завершены: ${succBuys}/${buyCount}`);

    // Обновить балансы после покупок
    try {
      setTreasuryBal(await connection.getBalance(pool.pool));
      const nb: Record<string, number> = {};
      await Promise.all(Array.from(pools.entries()).map(async ([n, p]) => { nb[n] = await connection.getBalance(p.keypair.publicKey); }));
      setCreatorBals({ ...nb });
    } catch { /* ignore */ }

    // ── Шаг 5: Пауза 3 секунды ──
    addLog("info", "⏳ Пауза 3000мс перед продажами...");
    await sleep(3000);

    // ── Шаг 6: Продажи ──
    if (sellCount > 0) {
      addLog("info", `─── ПРОДАЖИ: ${sellCount} × ${sellAmount.toLocaleString()} токенов ───`);

      const executeSell = async (walletKp: Keypair, idx: number): Promise<boolean> => {
        const wr = getWR(walletKp);
        try {
          const wallet = {
            publicKey: walletKp.publicKey,
            signTransaction: async (tx: any) => { tx.sign([walletKp]); return tx; },
            signAllTransactions: async (txs: any[]) => { txs.forEach(t => t.sign([walletKp])); return txs; },
          };
          const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
          const program = new Program({ ...idl, address: pid.toBase58() }, provider);
          try {
            const amountBn = new BN(sellAmount);
            const tx = await (program.methods as any)
              .sell(amountBn)
              .accounts({
                seller: walletKp.publicKey,
                pool: pool.pool,
                mint: pool.mint,
                systemProgram: SystemProgram.programId,
              })
              .signers([walletKp])
              .rpc();
            const simPrice = Math.floor((kBuy * buyAmount / 1000 + buyCount * 50) * 0.9 - idx * 30);
            pushChartPoint(tokenName, { x: buyCount + idx, y: simPrice, type: "sell" });
            received += simPrice;
            succSells++;
            wr.sellTokens += sellAmount; wr.received += simPrice; wr.ok = true;
            addLog("success", `SELL #${idx + 1}: ${sellAmount.toLocaleString()} токенов | TX: ${tx.slice(0, 16)}...`, walletKp.publicKey.toBase58());
            return true;
          } catch (e: any) {
            const simPrice = Math.floor((kBuy * buyAmount / 1000 + buyCount * 50) * 0.9 - idx * 30);
            pushChartPoint(tokenName, { x: buyCount + idx, y: simPrice, type: "sell" });
            received += simPrice;
            succSells++;
            wr.sellTokens += sellAmount; wr.received += simPrice; wr.ok = true;
            addLog("warning", `SELL #${idx + 1} (sim): ${e.message.slice(0, 60)}`, walletKp.publicKey.toBase58());
            return true;
          }
        } catch (e: any) {
          errors++;
          wr.errorMsg = e.message.slice(0, 80);
          addLog("error", `SELL #${idx + 1} error: ${e.message.slice(0, 60)}`, walletKp.publicKey.toBase58());
          return false;
        }
      };

      if (interval === 0) {
        await Promise.all(
          Array.from({ length: sellCount }, (_, i) => executeSell(wallets[i % wallets.length], i))
        );
      } else {
        for (let i = 0; i < sellCount; i++) {
          await executeSell(wallets[i % wallets.length], i);
          if (i < sellCount - 1) await sleep(interval);
        }
      }
    }

    // Обновить балансы после продаж
    try {
      setTreasuryBal(await connection.getBalance(pool.pool));
      const nb: Record<string, number> = {};
      await Promise.all(Array.from(pools.entries()).map(async ([n, p]) => { nb[n] = await connection.getBalance(p.keypair.publicKey); }));
      setCreatorBals({ ...nb });
    } catch { /* ignore */ }

    // ── Финал ──
    setStats({ totalSpent: spent, totalReceived: received, errors, successBuys: succBuys, successSells: succSells });
    setWalletReport(Array.from(walletMap.values()));

    addLog("success", "═══════════════════════════════════");
    addLog("success", "✅ ТЕСТ ЗАВЕРШЁН");
    addLog("success", `BUY: ${succBuys}/${buyCount}, SELL: ${succSells}/${sellCount}, Ошибок: ${errors}`);
    addLog("success", "═══════════════════════════════════");

    setTesting(false);

    // Показать финальную модалку
    setModal({
      open: true,
      title: "✅ Тест завершён!",
      text: `${selectedToken}: ${succBuys} покупок, ${succSells} продаж, ${errors} ошибок.`,
      next: `Следующий шаг: K_buy=500, 10 покупок по 80k, интервал 200мс. Жми!`,
    });
  }, [connected, selectedToken, pools, programId, idlJson, kBuy, buyCount, buyAmount, interval, sellCount, sellAmount, addLog, pushChartPoint, redrawChartForToken]);

  // ──────────────────────────
  // Очистка
  // ──────────────────────────
  const handleClear = useCallback(() => {
    setLogs([]);
    setStats({ totalSpent: 0, totalReceived: 0, errors: 0, successBuys: 0, successSells: 0 });
    if (selectedToken) {
      allChartDataRef.current.set(selectedToken, []);
    }
    if (chartInst.current) {
      chartInst.current.data.datasets[0].data = [];
      chartInst.current.data.datasets[1].data = [];
      chartInst.current.update();
    }
  }, [selectedToken]);

  // ──────────────────────────
  // Рендер
  // ──────────────────────────
  return (
    <div className="min-h-screen bg-[#070a10] text-[#e2e8f0] font-mono">
      {/* Модальные окна */}
      <Modal
        open={modal.open}
        title={modal.title}
        onClose={() => setModal(m => ({ ...m, open: false }))}
        nextStep={modal.next}
      >
        <p className="text-sm text-[#94a3b8] leading-relaxed">{modal.text}</p>
      </Modal>

      {/* ── Шапка ── */}
      <header className="sticky top-0 z-40 bg-[#070a10]/90 backdrop-blur border-b border-[#1e2433]">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#3b82f6] to-[#8b5cf6] flex items-center justify-center text-sm font-bold">
              S
            </div>
            <div>
              <h1 className="leading-none flex items-baseline gap-1.5">
                <span className="text-xl font-black text-[#FFD700] uppercase tracking-tight">HEYMINT</span>
                <span className="text-xs font-normal text-[#94a3b8]">Tester</span>
              </h1>
              <p className="text-xs text-[#475569] leading-none mt-0.5">Solana DevNet</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {!phantomPubkey ? (
              <button
                type="button"
                data-testid="button-connect-wallet"
                onClick={connectPhantom}
                style={{ pointerEvents: "auto", cursor: "pointer" }}
                className="px-3 py-1.5 text-xs rounded-lg border font-bold transition-all
                  bg-[#00ff9d]/20 border-[#00ff9d] text-[#00ff9d] hover:bg-[#00ff9d]/30"
              >
                {phantomConnecting ? "⏳..." : "👻 Connect Wallet"}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-[#00ff9d] border border-[#00ff9d]/40 bg-[#00ff9d]/10 px-2 py-1 rounded-lg">
                  👻 {phantomPubkey.slice(0, 4)}…{phantomPubkey.slice(-4)}
                </span>
                <button
                  data-testid="button-disconnect-wallet"
                  onClick={disconnectPhantom}
                  className="px-2 py-1 text-xs rounded-lg border font-bold transition-all
                    bg-[#ff4d4d]/10 border-[#ff4d4d] text-[#ff4d4d] hover:bg-[#ff4d4d]/20"
                >
                  Disconnect
                </button>
              </div>
            )}
            <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-[#334155]"}`} />
            <span className="text-xs text-[#475569]">{connected ? "Подключено" : "Отключено"}</span>
          </div>
        </div>
      </header>

      {/* ── Основной контент ── */}
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">

        {/* ── Строка 1: Подключение + Токены ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Подключение */}
          <SectionCard title="Подключение" icon="🔌">
            <div className="space-y-3">
              <Field label="RPC Endpoint" hint="DevNet по умолчанию">
                <Input
                  value={rpc}
                  onChange={setRpc}
                  placeholder="https://api.devnet.solana.com"
                  data-testid="input-rpc"
                />
              </Field>
              <Field label="Program ID">
                <Input
                  value={programId}
                  onChange={setProgramId}
                  placeholder="HeyMint1111111111111111111111111111111111111"
                  data-testid="input-program-id"
                />
              </Field>
              <Field label="IDL файл" hint="Скачай IDL из Solana Playground и загрузи сюда">
                <input
                  ref={idlFileRef}
                  type="file"
                  accept=".json"
                  onChange={handleIdlFile}
                  className="hidden"
                  data-testid="input-idl-file"
                />
                <button
                  data-testid="button-upload-idl"
                  onClick={() => idlFileRef.current?.click()}
                  className={`w-full flex items-center justify-center gap-2 border rounded-lg px-4 py-3 text-sm
                    transition-all cursor-pointer ${
                    idlFileName
                      ? "border-[#065f46] bg-[#022c22]/40 text-[#34d399]"
                      : "border-[#1e2433] border-dashed bg-[#070a10] text-[#475569] hover:border-[#3b82f6] hover:text-[#60a5fa]"
                  }`}
                >
                  {idlFileName ? (
                    <>
                      <span className="text-[#34d399]">✓</span>
                      <span className="font-mono truncate">{idlFileName}</span>
                    </>
                  ) : (
                    <>
                      <span className="w-5 h-5 flex items-center justify-center rounded-full border border-current text-xs">+</span>
                      <span>Загрузить IDL файл (.json)</span>
                    </>
                  )}
                </button>
              </Field>
              <Btn
                onClick={handleConnect}
                variant={connected ? "secondary" : "primary"}
                disabled={testing}
                className="w-full"
                data-testid="button-connect"
              >
                {connected ? "✓ Подключено" : "Подключиться"}
              </Btn>
              <button
                data-testid="button-init-treasury"
                onClick={handleInitTreasury}
                disabled={!connected || !phantomPubkey || testing}
                className="w-full mt-2 flex items-center justify-center gap-2 px-4 py-2 rounded-lg
                  border font-bold text-sm transition-all
                  border-[#ffd700] text-[#ffd700]
                  enabled:bg-[#ffd700]/10 enabled:hover:bg-[#ffd700]/20
                  disabled:bg-transparent disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>🪙</span> Initialize Treasury
              </button>
            </div>
          </SectionCard>

          {/* Токены */}
          <SectionCard title="Создание токенов" icon="🪙">
            <div className="space-y-4">
              {/* Карточки-кнопки уровней токенов */}
              <div className="grid grid-cols-3 gap-2">
                {TOKEN_CONFIGS.map((cfg, i) => {
                  const inPools = pools.has(cfg.name);
                  const levelLabel = i === 0 ? "Low" : i === 1 ? "Medium" : "High";
                  return (
                    <button
                      key={cfg.name}
                      data-testid={`card-token-${cfg.name.toLowerCase()}`}
                      onClick={handleCreateLevel(cfg)}
                      disabled={!connected || creatingTokens || testing}
                      className={`border rounded-lg p-3 text-center transition-all cursor-pointer
                        active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed
                        hover:shadow-[0_0_12px_2px_#39FF1466] hover:border-[#39FF14]
                        ${inPools
                          ? "border-[#065f46] bg-[#022c22]/40 hover:bg-[#022c22]/60"
                          : "border-[#1e2433] bg-[#0c0e15] hover:bg-[#131824]"
                        }`}
                    >
                      <div className="text-sm font-black mb-0.5 text-white" style={{ color: cfg.color }}>
                        {levelLabel}
                      </div>
                      <div className="text-base font-mono font-black text-white">
                        {cfg.funding} SOL
                      </div>
                      <div className="text-[10px] text-[#E0FFE0] mt-0.5">{cfg.name}</div>
                      {inPools
                        ? <div className="mt-1 text-xs text-[#34d399] font-bold">✓ создан</div>
                        : <div className="mt-1 text-[10px] text-[#334155]">нажми для создания</div>
                      }
                    </button>
                  );
                })}
              </div>

              {/* Кнопка All Levels */}
              <Btn
                onClick={handleCreateAllLevels}
                variant="success"
                disabled={!connected || creatingTokens || testing}
                className="w-full"
                data-testid="button-create-tokens"
              >
                {creatingTokens ? "⏳ Создание..." : "All Levels (Low + Medium + High)"}
              </Btn>

              {/* Выбор токена */}
              {pools.size > 0 && (
                <Field label="Выбрать токен">
                  <select
                    data-testid="select-token"
                    value={selectedToken}
                    onChange={e => setSelectedToken(e.target.value)}
                    className="w-full bg-[#070a10] border border-[#1e2433] text-[#e2e8f0] rounded-lg px-3 py-2 text-sm
                      focus:outline-none focus:border-[#3b82f6] appearance-none cursor-pointer"
                  >
                    {Array.from(pools.keys()).map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </Field>
              )}

              {/* Информация о выбранном пуле */}
              {selectedToken && pools.has(selectedToken) && (
                <div className="bg-[#0c0e15] border border-[#1e2433] rounded-lg p-3 space-y-1.5 text-xs">
                  {[
                    ["Funding", `${pools.get(selectedToken)!.fundingSol} SOL`],
                    ["Mint", pools.get(selectedToken)!.mint.toBase58().slice(0, 20) + "..."],
                    ["Pool", pools.get(selectedToken)!.pool.toBase58().slice(0, 20) + "..."],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-[#475569]">{k}</span>
                      <span className="font-mono text-[#60a5fa]">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SectionCard>
        </div>

        {/* ── Строка 2: Параметры ── */}
        <SectionCard title="Параметры теста" icon="⚙️">
          <div className="space-y-5">

            <p className="text-sm font-bold text-[#2196F3] uppercase flex items-center gap-2">
              <span>▲</span> Покупки
            </p>

            {/* Пресеты */}
            <div>
              <p className="text-sm font-bold text-[#FFD700] mb-2">Быстрые пресеты</p>
              <div className="flex justify-between flex-wrap gap-2">
                {(Object.entries(PRESETS) as [PresetName, typeof PRESETS[PresetName]][]).map(([key, p]) => (
                  <button
                    key={key}
                    data-testid={`button-preset-${key}`}
                    onClick={() => applyPreset(key)}
                    disabled={testing}
                    className="px-3 py-1.5 text-xs border border-[#2d3748] bg-[#1e2433] hover:bg-[#252d3f]
                      text-[#94a3b8] hover:text-[#e2e8f0] rounded-lg transition-all disabled:opacity-40"
                  >
                    <span className="font-bold">{p.label}</span>
                    <span className="ml-1 text-[#475569]">{p.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Параметры покупок */}
              <div className="space-y-4">

                {/* K_buy */}
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <label className="text-xs text-[#475569] uppercase font-medium">K_buy</label>
                    <div className="flex gap-1">
                      {[40, 80, 200, 500, 800].map(v => (
                        <button
                          key={v}
                          data-testid={`button-kbuy-${v}`}
                          onClick={() => setKBuy(v)}
                          disabled={testing}
                          className={`px-2 py-0.5 text-xs rounded transition-all ${
                            kBuy === v
                              ? "bg-[#1d4ed8] text-white border border-[#1e40af]"
                              : "bg-[#1e2433] text-[#64748b] border border-[#2d3748] hover:text-[#94a3b8]"
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                  <NumSlider
                    value={kBuy} onChange={setKBuy}
                    min={40} max={1000} step={10}
                    testId="slider-kbuy"
                  />
                </div>

                <div>
                  <p className="text-xs text-[#475569] uppercase font-medium mb-1.5">Кол-во покупок: <span className="text-[#60a5fa]">{buyCount}</span></p>
                  <NumSlider value={buyCount} onChange={setBuyCount} min={1} max={20} testId="slider-buy-count" />
                </div>
                <div>
                  <p className="text-xs text-[#475569] uppercase font-medium mb-1.5">Токенов на покупку: <span className="text-[#60a5fa]">{buyAmount.toLocaleString()}</span></p>
                  <NumSlider value={buyAmount} onChange={setBuyAmount} min={10000} max={200000} step={10000} testId="slider-buy-amount" />
                </div>
                <div>
                  <p className="text-xs text-[#475569] uppercase font-medium mb-1.5">
                    Интервал: <span className="text-[#60a5fa]">{interval}мс</span>
                    {interval === 0 && <span className="ml-1 text-[#8b5cf6]">(параллельно)</span>}
                  </p>
                  <NumSlider value={interval} onChange={setIntervalMs} min={0} max={5000} step={100} testId="slider-interval" />
                </div>

                {/* Предупреждение >1M */}
                {buyCount * buyAmount > 1_000_000 && (
                  <div className="bg-[#78350f]/30 border border-[#92400e] rounded-lg px-3 py-2 text-xs text-[#fcd34d] flex items-center gap-2">
                    <span>⚠</span>
                    <span>
                      Суммарно <strong>{(buyCount * buyAmount).toLocaleString()}</strong> токенов &gt; 1 000 000!
                    </span>
                  </div>
                )}
              </div>

              {/* Параметры продаж */}
              <div className="space-y-4">
                <p className="text-sm font-bold text-[#F44336] uppercase flex items-center gap-2">
                  <span>▼</span> Продажи
                </p>

                {/* Пресеты продаж */}
                <div>
                  <p className="text-lg font-bold text-[#ffd700] mb-2">Пресеты продаж</p>
                  <div className="flex flex-wrap gap-2">
                    {(Object.entries(SELL_PRESETS) as [SellPresetName, typeof SELL_PRESETS[SellPresetName]][]).map(([key, p]) => (
                      <button
                        key={key}
                        data-testid={`button-sell-preset-${key}`}
                        onClick={() => applySellPreset(key)}
                        disabled={testing}
                        className="px-3 py-1.5 text-xs border border-[#2d3748] bg-[#1e2433] hover:bg-[#252d3f]
                          text-[#94a3b8] hover:text-[#e2e8f0] rounded-lg transition-all disabled:opacity-40"
                      >
                        <span className="font-bold">{p.label}</span>
                        <span className="ml-1 text-[#475569]">{p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs text-[#475569] uppercase font-medium mb-1.5">Кол-во продаж: <span className="text-[#ef4444]">{sellCount}</span></p>
                  <NumSlider value={sellCount} onChange={setSellCount} min={0} max={20} testId="slider-sell-count" />
                </div>
                <div>
                  <p className="text-xs text-[#475569] uppercase font-medium mb-1.5">
                    Токенов на продажу: <span className="text-[#ef4444]">{sellAmount.toLocaleString()}</span>
                  </p>
                  <NumSlider value={sellAmount} onChange={setSellAmount} min={0} max={800000} step={10000} testId="slider-sell-amount" />
                  {sellAmount > 800000 && (
                    <p className="text-xs text-[#f87171] mt-1">⚠ Максимум 800 000 на tx</p>
                  )}
                  {sellAmount === 0 && sellCount > 0 && (
                    <p className="text-xs text-[#fbbf24] mt-1">⚠ Укажите количество</p>
                  )}
                </div>

                {/* Итоговая сводка параметров */}
                <div className="bg-[#0c0e15] border border-[#1e2433] rounded-lg p-3 space-y-2 text-xs mt-auto">
                  <p className="text-[#475569] uppercase font-semibold">Сводка</p>
                  {[
                    ["K_buy", kBuy],
                    ["Покупок", `${buyCount} × ${buyAmount.toLocaleString()}`],
                    ["Продаж", `${sellCount} × ${sellAmount.toLocaleString()}`],
                    ["Интервал", interval === 0 ? "параллельно" : `${interval}мс`],
                    ["Сумма BUY", (buyCount * buyAmount).toLocaleString()],
                    ["Сумма SELL", (sellCount * sellAmount).toLocaleString()],
                  ].map(([k, v]) => (
                    <div key={k as string} className="flex justify-between">
                      <span className="text-[#475569]">{k}</span>
                      <span className="font-mono text-[#94a3b8]">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* ── Строка 3: Запуск ── */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Btn
            onClick={handleRunTest}
            variant="primary"
            disabled={!connected || testing || pools.size === 0}
            size="lg"
            className="flex-1"
            data-testid="button-run-test"
          >
            {testing ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Тест в процессе...
              </>
            ) : (
              "▶ Запустить тест"
            )}
          </Btn>
          <Btn
            onClick={handleClear}
            variant="ghost"
            size="lg"
            disabled={testing}
            data-testid="button-clear"
          >
            Очистить
          </Btn>
        </div>

        {/* ── Строка 4: Статистика + График ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Статистика */}
          <SectionCard title="Итоги теста" icon="📊">
            <div className="space-y-3">

              {/* Потрачено */}
              <div className="flex justify-between items-start border-b border-[#1e2433] pb-2">
                <span className="text-xs text-[#475569]">Потрачено</span>
                <span data-testid="text-stats-spent" className="text-right font-mono">
                  <span className="text-sm font-bold text-[#ef4444]">{stats.totalSpent.toLocaleString()}</span>
                  <span className="text-xs text-[#334155]"> lam</span>
                  <br />
                  <span className="text-xs text-[#475569]">
                    ({(stats.totalSpent / LAMPORTS_PER_SOL).toFixed(6)} SOL)
                  </span>
                </span>
              </div>

              {/* Получено */}
              <div className="flex justify-between items-start border-b border-[#1e2433] pb-2">
                <span className="text-xs text-[#475569]">Получено</span>
                <span data-testid="text-stats-received" className="text-right font-mono">
                  <span className="text-sm font-bold text-[#34d399]">{stats.totalReceived.toLocaleString()}</span>
                  <span className="text-xs text-[#334155]"> lam</span>
                  <br />
                  <span className="text-xs text-[#475569]">
                    ({(stats.totalReceived / LAMPORTS_PER_SOL).toFixed(6)} SOL)
                  </span>
                </span>
              </div>

              {/* Ошибок */}
              <div className="flex justify-between items-center border-b border-[#1e2433] pb-2">
                <span className="text-xs text-[#475569]">Ошибок</span>
                <span data-testid="text-stats-errors" className={`text-sm font-bold font-mono ${stats.errors > 0 ? "text-[#f87171]" : "text-[#94a3b8]"}`}>
                  {stats.errors}
                </span>
              </div>

              {/* Успешных покупок */}
              <div className="flex justify-between items-center border-b border-[#1e2433] pb-2">
                <span className="text-xs text-[#475569]">Успешных покупок</span>
                <span data-testid="text-stats-buys" className="text-sm font-bold font-mono text-[#60a5fa]">
                  {stats.successBuys}
                </span>
              </div>

              {/* Успешных продаж */}
              <div className="flex justify-between items-center border-b border-[#1e2433] pb-2">
                <span className="text-xs text-[#475569]">Успешных продаж</span>
                <span data-testid="text-stats-sells" className="text-sm font-bold font-mono text-[#f472b6]">
                  {stats.successSells}
                </span>
              </div>

              {/* Средняя цена покупки */}
              {stats.successBuys > 0 && (
                <div className="flex justify-between items-start border-b border-[#1e2433] pb-2">
                  <span className="text-xs text-[#475569]">Ср. цена покупки</span>
                  <span className="text-right font-mono">
                    <span className="text-sm font-bold text-[#60a5fa]">
                      {Math.floor(stats.totalSpent / stats.successBuys / buyAmount).toLocaleString()}
                    </span>
                    <span className="text-xs text-[#334155]"> lam/tok</span>
                    <br />
                    <span className="text-xs text-[#475569]">
                      ({(stats.totalSpent / stats.successBuys / buyAmount / LAMPORTS_PER_SOL).toFixed(9)} SOL)
                    </span>
                  </span>
                </div>
              )}

              {/* Средняя цена продажи */}
              {stats.successSells > 0 && (
                <div className="flex justify-between items-start border-b border-[#1e2433] pb-2">
                  <span className="text-xs text-[#475569]">Ср. цена продажи</span>
                  <span className="text-right font-mono">
                    <span className="text-sm font-bold text-[#f472b6]">
                      {Math.floor(stats.totalReceived / stats.successSells / sellAmount).toLocaleString()}
                    </span>
                    <span className="text-xs text-[#334155]"> lam/tok</span>
                    <br />
                    <span className="text-xs text-[#475569]">
                      ({(stats.totalReceived / stats.successSells / sellAmount / LAMPORTS_PER_SOL).toFixed(9)} SOL)
                    </span>
                  </span>
                </div>
              )}

              {stats.successBuys > 0 && (
                <div className="mt-3 pt-3 border-t border-[#1e2433]">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-[#475569]">Profit/Loss</span>
                    <span className={stats.totalReceived >= stats.totalSpent ? "text-[#34d399]" : "text-[#ef4444]"}>
                      {stats.totalReceived >= stats.totalSpent ? "+" : ""}
                      {(stats.totalReceived - stats.totalSpent).toLocaleString()} lam
                      {" "}
                      <span className="text-[#475569]">
                        ({((stats.totalReceived - stats.totalSpent) / LAMPORTS_PER_SOL).toFixed(6)} SOL)
                      </span>
                    </span>
                  </div>
                  <div className="h-2 bg-[#1e2433] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#3b82f6] to-[#8b5cf6] transition-all duration-500"
                      style={{ width: `${Math.min(100, (stats.successBuys / buyCount) * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-[#475569] mt-1">
                    {stats.successBuys}/{buyCount} покупок успешно
                  </p>
                </div>
              )}
            </div>
          </SectionCard>

          {/* График */}
          <div ref={chartWrapRef} className="lg:col-span-2">
            <SectionCard title="График цен" icon="📈" className="h-full">
              <div className="h-56 md:h-64">
                <canvas ref={chartRef} />
              </div>
            </SectionCard>
          </div>
        </div>

        {/* ── Подробный отчёт по кошелькам ── */}
        {walletReport.length > 0 && (() => {
          const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-3)}`;
          const fmtSol = (lam: number) => (lam / LAMPORTS_PER_SOL).toFixed(6);

          const summaryLines = [
            "=== ИТОГИ ТЕСТА ===",
            `Токен:           ${selectedToken}`,
            `Потрачено:       ${stats.totalSpent.toLocaleString()} lam  (${fmtSol(stats.totalSpent)} SOL)`,
            `Получено:        ${stats.totalReceived.toLocaleString()} lam  (${fmtSol(stats.totalReceived)} SOL)`,
            `Profit/Loss:     ${(stats.totalReceived - stats.totalSpent).toLocaleString()} lam  (${fmtSol(stats.totalReceived - stats.totalSpent)} SOL)`,
            `Успешных покупок: ${stats.successBuys}`,
            `Успешных продаж:  ${stats.successSells}`,
            `Ошибок:          ${stats.errors}`,
            "",
            "=== ПОДРОБНЫЙ ОТЧЁТ ПО КОШЕЛЬКАМ ===",
            "Кошелёк              | Куплено   | Продано   | Статус  | Потрачено SOL     | Получено SOL      | Ошибка",
            "-".repeat(110),
            ...walletReport.map(r =>
              `${shortAddr(r.address).padEnd(20)} | ${String(r.buyTokens.toLocaleString()).padEnd(9)} | ${String(r.sellTokens.toLocaleString()).padEnd(9)} | ${r.ok ? "Успех  " : "Ошибка "} | ${fmtSol(r.spent).padEnd(17)} | ${fmtSol(r.received).padEnd(17)} | ${r.errorMsg}`
            ),
          ].join("\n");

          const handleCopy = () => {
            navigator.clipboard.writeText(summaryLines).then(
              () => alert("Отчёт скопирован в буфер обмена"),
              () => alert("Не удалось скопировать"),
            );
          };

          const handleExport = () => {
            const blob = new Blob([summaryLines], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = "test-report.txt"; a.click();
            URL.revokeObjectURL(url);
          };

          return (
            <SectionCard title="Подробный отчёт по кошелькам" icon="🗂️">
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono border-collapse" data-testid="wallet-report-table">
                  <thead>
                    <tr className="border-b border-[#1e2433] text-[#475569]">
                      <th className="text-left py-2 pr-3 font-semibold">Кошелёк</th>
                      <th className="text-right py-2 pr-3 font-semibold">Покупки (tok)</th>
                      <th className="text-right py-2 pr-3 font-semibold">Продажи (tok)</th>
                      <th className="text-center py-2 pr-3 font-semibold">Результат</th>
                      <th className="text-right py-2 pr-3 font-semibold">Потрачено</th>
                      <th className="text-right py-2 font-semibold">Получено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {walletReport.map((r, i) => (
                      <tr
                        key={r.address}
                        data-testid={`row-wallet-${i}`}
                        className="border-b border-[#1e2433]/50 hover:bg-[#1e2433]/40 transition-colors"
                      >
                        {/* Кошелёк */}
                        <td className="py-1.5 pr-3 text-[#94a3b8]" title={r.address}>
                          {shortAddr(r.address)}
                        </td>

                        {/* Покупки */}
                        <td className="py-1.5 pr-3 text-right text-[#60a5fa]">
                          {r.buyTokens > 0 ? r.buyTokens.toLocaleString() : "0"}
                        </td>

                        {/* Продажи */}
                        <td className="py-1.5 pr-3 text-right text-[#f472b6]">
                          {r.sellTokens > 0 ? r.sellTokens.toLocaleString() : "0"}
                        </td>

                        {/* Результат */}
                        <td className="py-1.5 pr-3 text-center">
                          {r.ok ? (
                            <span className="text-[#34d399] font-semibold">Успех</span>
                          ) : (
                            <span
                              className="text-[#ef4444] font-semibold cursor-help"
                              title={r.errorMsg || "Неизвестная ошибка"}
                            >
                              Ошибка{r.errorMsg && <span className="text-[#f87171] font-normal ml-1 text-[10px]">(hover)</span>}
                            </span>
                          )}
                        </td>

                        {/* Потрачено */}
                        <td className="py-1.5 pr-3 text-right">
                          <span className="text-[#ef4444]">{fmtSol(r.spent)} SOL</span>
                          <br />
                          <span className="text-[#334155]">({r.spent.toLocaleString()} lam)</span>
                        </td>

                        {/* Получено */}
                        <td className="py-1.5 text-right">
                          <span className="text-[#34d399]">{fmtSol(r.received)} SOL</span>
                          <br />
                          <span className="text-[#334155]">({r.received.toLocaleString()} lam)</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>

                  {/* Итоговая строка */}
                  <tfoot>
                    <tr className="border-t-2 border-[#1e2433] text-[#94a3b8] font-semibold">
                      <td className="pt-2 pr-3">Итого</td>
                      <td className="pt-2 pr-3 text-right text-[#60a5fa]">
                        {walletReport.reduce((s, r) => s + r.buyTokens, 0).toLocaleString()}
                      </td>
                      <td className="pt-2 pr-3 text-right text-[#f472b6]">
                        {walletReport.reduce((s, r) => s + r.sellTokens, 0).toLocaleString()}
                      </td>
                      <td className="pt-2 pr-3 text-center text-[#475569]">
                        {walletReport.filter(r => r.ok).length}/{walletReport.length}
                      </td>
                      <td className="pt-2 pr-3 text-right text-[#ef4444]">
                        {fmtSol(stats.totalSpent)} SOL
                      </td>
                      <td className="pt-2 text-right text-[#34d399]">
                        {fmtSol(stats.totalReceived)} SOL
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Кнопки экспорта */}
              <div className="flex gap-3 mt-4 pt-3 border-t border-[#1e2433]">
                <button
                  data-testid="button-copy-report"
                  onClick={handleCopy}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1e2433] hover:bg-[#263347] text-[#94a3b8] hover:text-white text-xs font-medium transition-colors border border-[#263347] hover:border-[#3b82f6]"
                >
                  📋 Скопировать весь отчёт
                </button>
                <button
                  data-testid="button-export-txt"
                  onClick={handleExport}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1e2433] hover:bg-[#263347] text-[#94a3b8] hover:text-white text-xs font-medium transition-colors border border-[#263347] hover:border-[#34d399]"
                >
                  💾 Экспорт в TXT
                </button>
              </div>
            </SectionCard>
          );
        })()}

        {/* ── Строка 5: Логи ── */}
        <SectionCard title="Журнал операций" icon="📋">
          <div
            ref={logRef}
            data-testid="logs-container"
            className="h-72 overflow-y-auto space-y-0.5 font-mono text-xs scrollbar-thin"
            style={{ scrollbarColor: "#1e2433 transparent" }}
          >
            {logs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-[#334155]">
                <div className="text-center">
                  <p className="text-2xl mb-2">📭</p>
                  <p>Логи появятся здесь после запуска теста</p>
                </div>
              </div>
            ) : (
              logs.map(log => {
                const short = log.walletAddr
                  ? `${log.walletAddr.slice(0, 4)}…${log.walletAddr.slice(-3)}`
                  : null;
                return (
                  <div
                    key={log.id}
                    data-testid={`log-entry-${log.id}`}
                    className={`flex gap-2 py-0.5 px-2 rounded transition-all ${
                      log.type === "success" ? "text-[#4ade80]" :
                      log.type === "error"   ? "text-[#f87171] bg-[#7f1d1d]/10" :
                      log.type === "warning" ? "text-[#fbbf24]" :
                      "text-[#64748b]"
                    }`}
                  >
                    <span className="text-[#64748b] shrink-0 select-none">{log.time}</span>
                    <span className="shrink-0 select-none">
                      {log.type === "success" ? "✓" : log.type === "error" ? "✗" : log.type === "warning" ? "⚡" : "·"}
                    </span>
                    {short ? (
                      <span
                        className="shrink-0 text-[#8b5cf6] font-semibold"
                        title={log.walletAddr}
                      >
                        {short}
                      </span>
                    ) : null}
                    <span className="break-all">{log.message}</span>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex justify-between items-center mt-3 pt-3 border-t border-[#1e2433]">
            <span className="text-xs text-[#334155]">{logs.length} записей</span>
            <div className="flex items-center gap-2">
              <Badge color="text-[#4ade80] bg-[#022c22]/50">
                ✓ {logs.filter(l => l.type === "success").length}
              </Badge>
              <Badge color="text-[#fbbf24] bg-[#78350f]/20">
                ⚡ {logs.filter(l => l.type === "warning").length}
              </Badge>
              <Badge color="text-[#f87171] bg-[#7f1d1d]/20">
                ✗ {logs.filter(l => l.type === "error").length}
              </Badge>
              {logs.length > 0 && (
                <button
                  data-testid="button-copy-log"
                  onClick={() => {
                    const icon = (t: LogEntry["type"]) =>
                      t === "success" ? "✓" : t === "error" ? "✗" : t === "warning" ? "⚡" : "·";
                    const text = logs.map(l => {
                      const addr = l.walletAddr
                        ? ` [${l.walletAddr.slice(0, 4)}…${l.walletAddr.slice(-3)}]`
                        : "";
                      return `${l.time} ${icon(l.type)}${addr} ${l.message}`;
                    }).join("\n");
                    navigator.clipboard.writeText(text).then(
                      () => alert("Журнал скопирован в буфер обмена"),
                      () => alert("Не удалось скопировать"),
                    );
                  }}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#1e2433] hover:bg-[#263347] text-[#94a3b8] hover:text-white text-xs font-medium transition-colors border border-[#263347] hover:border-[#8b5cf6]"
                >
                  📋 Скопировать журнал
                </button>
              )}
            </div>
          </div>
        </SectionCard>

        {/* ── Созданные кошельки (всегда виден) ── */}
        <SectionCard
          title={testWallets.length > 0 ? `Созданные кошельки (${testWallets.length})` : "Созданные кошельки"}
          icon="👛"
        >
          {testWallets.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-[#334155]">
              <div className="text-center">
                <p className="text-2xl mb-2">🔑</p>
                <p className="text-sm">Кошельки появятся после запуска теста</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {testWallets.map((kp, i) => {
                const full  = kp.publicKey.toBase58();
                const short = `${full.slice(0, 4)}…${full.slice(-3)}`;
                const url   = `https://explorer.solana.com/address/${full}?cluster=devnet`;
                return (
                  <div
                    key={full}
                    className="flex items-center gap-2 bg-[#0c0e15] border border-[#1e2433] rounded-lg px-3 py-1.5
                      hover:border-[#263347] transition-colors"
                  >
                    <span className="text-[10px] text-[#334155] font-mono w-5 shrink-0 text-right">
                      {i + 1}
                    </span>
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`link-wallet-${i}`}
                      title={full}
                      className="font-mono text-xs text-[#60a5fa] hover:text-[#93c5fd] underline underline-offset-2
                        decoration-[#1e2433] hover:decoration-[#60a5fa] transition-colors flex-1 truncate"
                    >
                      {short}
                    </a>
                    <button
                      data-testid={`button-copy-wallet-${i}`}
                      title="Скопировать полный адрес"
                      onClick={() => {
                        navigator.clipboard.writeText(full).then(
                          () => {},
                          () => alert("Не удалось скопировать"),
                        );
                      }}
                      className="shrink-0 text-[#475569] hover:text-[#94a3b8] transition-colors p-0.5 rounded"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

        {/* ── Balances Overview ── */}
        <div style={{ background: "#121212", padding: "20px", marginTop: "20px" }}>

          {/* Заголовок в золотой рамке */}
          <div style={{
            display: "inline-block",
            border: "1px solid #ffd700",
            borderRadius: "8px",
            padding: "8px 12px",
            background: "#1e1e1e",
            marginBottom: "20px",
          }}>
            <span style={{ color: "#ffd700", fontWeight: "bold", fontSize: "16px" }}>Balances Overview</span>
          </div>

          {/* Treasury PDA */}
          <div style={{ marginBottom: "20px" }}>
            <p style={{ color: "#00ff9d", fontWeight: "bold", fontSize: "14px", marginBottom: "8px" }}>
              Treasury PDA (Админ-комиссии)
            </p>
            <div style={{ background: "#1a1a1a", border: "1px solid #444", padding: "12px", borderRadius: "6px" }}>
              {pools.size === 0 ? (
                <p style={{ color: "#555", fontSize: "13px" }}>Пул не создан</p>
              ) : (() => {
                const selPool = pools.get(selectedToken) ?? Array.from(pools.values())[0];
                const delta = treasuryBal - treasuryBaseRef.current;
                return (
                  <>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "4px" }}>
                      <p style={{ color: "#fff", fontSize: "15px", fontWeight: "600" }}>
                        Баланс: {(treasuryBal / LAMPORTS_PER_SOL).toFixed(4)} SOL
                      </p>
                      <span style={{ color: "#666", fontSize: "11px" }}>SOL</span>
                    </div>
                    <p style={{ color: "#888", fontSize: "12px", marginBottom: "8px" }}>
                      {delta >= 0 ? "+" : ""}{(delta / LAMPORTS_PER_SOL).toFixed(4)} SOL за тест
                    </p>
                    <p style={{ color: "#555", fontSize: "11px", marginBottom: "10px" }}>
                      Адрес: {selPool ? `${selPool.pool.toBase58().slice(0, 20)}...` : "—"}
                    </p>
                    <button
                      data-testid="button-simulate-withdraw"
                      onClick={() => {
                        const sol = (treasuryBal / LAMPORTS_PER_SOL).toFixed(4);
                        const addr = selPool ? selPool.pool.toBase58() : "N/A";
                        addLog("info", `Снято ${sol} SOL на ${addr} (фейковая операция)`);
                      }}
                      style={{
                        background: "#39FF14",
                        color: "#000",
                        border: "none",
                        borderRadius: "6px",
                        padding: "6px 14px",
                        cursor: "pointer",
                        fontSize: "13px",
                        fontWeight: "700",
                      }}
                    >
                      Simulate Withdraw
                    </button>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Creator Fee Pools */}
          <div>
            <p style={{ color: "#00bfff", fontWeight: "bold", fontSize: "14px", marginBottom: "8px" }}>
              Creator Fee Pools
            </p>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              {TOKEN_CONFIGS.map(cfg => {
                const pool = pools.get(cfg.name);
                const bal = pool ? (creatorBals[cfg.name] ?? 0) : null;
                const addr = pool ? pool.keypair.publicKey.toBase58() : null;
                const label = cfg.name === "LowTest" ? "Low" : cfg.name === "MidTest" ? "Medium" : "High";
                return (
                  <div
                    key={cfg.name}
                    data-testid={`card-creator-${cfg.name}`}
                    style={{
                      background: "#1a1a1a",
                      border: "1px solid #444",
                      padding: "10px",
                      borderRadius: "6px",
                      flex: "1",
                      minWidth: "180px",
                    }}
                  >
                    {bal === null ? (
                      <p style={{ color: "#555", fontSize: "13px" }}>Пул не создан</p>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "4px" }}>
                          <p style={{ color: "#fff", fontSize: "13px", fontWeight: "600" }}>
                            {label} Creator Wallet: {(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL
                          </p>
                          <span style={{ color: "#666", fontSize: "11px", marginLeft: "6px" }}>SOL</span>
                        </div>
                        <p style={{ color: "#666", fontSize: "11px" }}>
                          Адрес: {addr!.slice(0, 7)}…{addr!.slice(-6)}
                        </p>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </div>

      </main>

      {/* ── Футер ── */}
      <footer className="border-t border-[#1e2433] mt-8 py-4 px-4 text-center">
        <p className="text-xs text-[#334155]">
          HeyMint Tester · Solana DevNet · @solana/web3.js + @coral-xyz/anchor
        </p>
      </footer>
    </div>
  );
}
