import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, CheckCheck, Eraser, ExternalLink, Languages, Loader2, PenLine, Play, RotateCcw, Scale, Search, ShieldAlert,
  ShieldCheck, SkipForward, Tags, X,
} from 'lucide-react';
import DraftText from '../components/DraftText.jsx';
import { useTickets } from '../state/tickets.jsx';
import { SAMPLES } from '../data/samples.js';
import { describeError } from '../api/normalize.js';
import { DECISIONS, GATE_THRESHOLDS, LANGUAGES, PRIORITIES, REASONS } from '../lib/constants.js';
import { ms, pct } from '../lib/format.js';
import { go, ticketHref } from '../lib/useHashRoute.js';

// Live triage: send one ticket and watch every pipeline stage. The engine answers in about a second;
// the reveal is slowed down so a room can follow it, and each step shows the engine's real timing.
const STAGES = [
  { id: 'gateway', label: 'Gateway', icon: ShieldCheck, dur: 1800 },
  { id: 'language', label: 'Language', icon: Languages, dur: 900 },
  { id: 'classify', label: 'Classify', icon: Tags, dur: 1300 },
  { id: 'retrieve', label: 'Retrieve', icon: Search, dur: 1400 },
  { id: 'gate', label: 'Gate', icon: Scale, dur: 2100 },
  { id: 'draft', label: 'Draft', icon: PenLine, dur: 2400 },
  { id: 'validate', label: 'Validate', icon: CheckCheck, dur: 1100 },
];

const KIND = {
  'de-vpn': ['Outage', 'text-red-300 bg-red-500/15'],
  'en-password': ['Routine', 'text-teal-200 bg-teal-400/15'],
  'en-refund-injection': ['Attack', 'text-rose-200 bg-rose-500/20'],
  'de-ransomware': ['Security', 'text-red-300 bg-red-500/15'],
  'en-pii': ['Personal data', 'text-sky-200 bg-sky-400/15'],
  'en-gdpr': ['Legal', 'text-amber-200 bg-amber-400/15'],
  'fr-login': ['Unsupported', 'text-slate-300 bg-white/10'],
};

const MAX_BODY = 10_000; // contract v1
const RULES = Object.entries(REASONS).sort((a, b) => a[1].severity.localeCompare(b[1].severity));
const TOKEN_SPLIT = /(\[(?:EMAIL|PHONE|IP|IBAN|CARD|ACCOUNT)_\d+\])/;
const ODD_SPACES = /[  -​  　]/g;

function useReducedMotion() {
  const [reduce, setReduce] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

// Lines up the masked text the gateway returned with what was typed, so each placeholder knows the
// value it replaced. Returns null when the two cannot be aligned; the card then shows the masked text only.
function alignMasked(original, masked) {
  const orig = original.replace(ODD_SPACES, ' ');
  const parts = masked.split(TOKEN_SPLIT);
  const segs = [];
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 1) {
      segs.push({ token: part, type: part.slice(1).split('_')[0], value: '' });
      continue;
    }
    if (!part) continue;
    const found = orig.indexOf(part, at);
    if (found === -1) return null;
    const prev = segs[segs.length - 1];
    if (found > at) {
      if (!prev?.token || prev.value) return null;
      prev.value = orig.slice(at, found);
    }
    segs.push({ text: part });
    at = found + part.length;
  }
  const last = segs[segs.length - 1];
  if (last?.token && !last.value) last.value = orig.slice(at);
  return segs.some((s) => s.token && !s.value) ? null : segs;
}

export default function TriageLab() {
  const { triage } = useTickets();
  const reduce = useReducedMotion();
  const [sample, setSample] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const bodyRef = useRef(null);
  const [sent, setSent] = useState(null);
  const [result, setResult] = useState(null);
  const [step, setStep] = useState(0); // stages fully done
  const [error, setError] = useState(null);
  const timers = useRef([]);
  const runId = useRef(0);
  const composer = useRef(null);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const started = sent != null;
  const finished = result != null && step >= STAGES.length;
  const running = started && !finished && !error;

  const pick = (s) => {
    setSample(s.id);
    setSubject(s.subject);
    setBody(s.body);
    setError(null);
  };
  // Any edit makes it the user's own ticket.
  const edit = (set, value) => {
    set(value);
    setSample(null);
    setError(null);
  };
  const clearForm = () => {
    setSubject('');
    setBody('');
    setSample(null);
    setError(null);
    bodyRef.current?.focus();
  };

  const run = async () => {
    if (running) return;
    if (!body.trim()) {
      setError('Write the message first. The subject is optional.');
      bodyRef.current?.focus();
      return;
    }
    clearTimers();
    const id = ++runId.current;
    setError(null);
    setResult(null);
    setStep(0);
    setSent({ subject: subject.trim(), body });
    try {
      const t = await triage({ subject: subject.trim(), body });
      if (id !== runId.current) return;
      setResult(t);
      if (reduce) {
        setStep(STAGES.length);
        return;
      }
      let acc = 0;
      STAGES.forEach((s, i) => {
        acc += s.dur;
        timers.current.push(setTimeout(() => setStep(i + 1), acc));
      });
    } catch (e) {
      if (id !== runId.current) return;
      setError(describeError(e));
      setSent(null);
    }
  };

  const skip = () => {
    clearTimers();
    setStep(STAGES.length);
  };

  // Keep the stage being revealed in view.
  useEffect(() => {
    if (!started) return;
    const el = document.getElementById(finished ? 'lab-verdict' : `lab-stage-${step}`);
    el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
  }, [step, started, finished, reduce]);

  const state = (i) => (!started ? 'idle' : i < step ? 'done' : i === step && !finished ? 'active' : 'pending');
  const visible = (i) => started && (i < step || (i === step && (i === 0 || result)));

  return (
    <div className="min-h-full bg-[#071521] text-slate-300">
      <div className="px-4 pt-6 pb-4 sm:px-6 lg:px-8">
        <h1 className="text-[26px] font-semibold tracking-tight text-white">Live triage</h1>
        <p className="mt-1 max-w-[72ch] text-[14.5px] leading-relaxed text-slate-400">
          Send a ticket and watch the whole pipeline: what the gateway hides before any model sees it, how the ticket is classified, which past
          tickets it matches, and which safety rules decide whether a reply can go out.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 px-4 pb-12 sm:px-6 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)] lg:px-8">
        {/* Composer: your own ticket first; scenarios underneath fill the same form */}
        <aside ref={composer} className="self-start rounded-2xl border border-white/10 bg-white/[0.03] p-4 lg:sticky lg:top-4">
          <form onSubmit={(e) => { e.preventDefault(); run(); }}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-semibold text-white">Your ticket</h2>
              {(subject || body) && !running && (
                <button type="button" onClick={clearForm} className="flex items-center gap-1 text-[12.5px] text-slate-400 hover:text-white">
                  <Eraser size={13} /> Clear
                </button>
              )}
            </div>
            <p className="mt-0.5 text-[12.5px] text-slate-400">
              {sample ? (
                <>Filled from the <b className="font-medium text-slate-200">{SAMPLES.find((x) => x.id === sample)?.label.replace(/^[A-Z]{2} · /, '')}</b> scenario. Edit it or write your own.</>
              ) : (
                'Write any support ticket, in any language.'
              )}
            </p>

            <label className="mt-3 block text-[13px] font-medium text-slate-300" htmlFor="lab-subject">
              Subject <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <input
              id="lab-subject"
              value={subject}
              onChange={(e) => edit(setSubject, e.target.value)}
              disabled={running}
              maxLength={300}
              placeholder="e.g. Cannot log in since this morning"
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-[14px] text-white placeholder:text-slate-500 outline-none focus:border-teal-300/70 focus:ring-2 focus:ring-teal-300/20"
            />
            <label className="mt-3 block text-[13px] font-medium text-slate-300" htmlFor="lab-body">Message</label>
            <textarea
              id="lab-body"
              ref={bodyRef}
              value={body}
              onChange={(e) => edit(setBody, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  run();
                }
              }}
              disabled={running}
              maxLength={MAX_BODY}
              rows={7}
              placeholder="Describe the problem as a customer would. Add an email or phone number to see the gateway hide it."
              className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-[14px] leading-relaxed text-white placeholder:text-slate-500 outline-none focus:border-teal-300/70 focus:ring-2 focus:ring-teal-300/20"
            />
            <div className="mt-1 flex justify-between text-[12px] text-slate-500">
              <span>Ctrl + Enter to run</span>
              <span className="tabular">{body.length.toLocaleString('en-US')} / {MAX_BODY.toLocaleString('en-US')}</span>
            </div>
            {error && <p role="alert" className="mt-2 rounded-lg bg-red-500/15 px-3 py-2 text-[13px] text-red-200">{error}</p>}
            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                disabled={running}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-teal-400 px-4 py-2.5 text-[14.5px] font-semibold text-[#04211e] transition hover:bg-teal-300 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none disabled:opacity-60"
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} fill="currentColor" />}
                {running ? 'Triaging…' : finished ? 'Run again' : 'Run triage'}
              </button>
              {running && result && (
                <button type="button" onClick={skip} className="flex items-center gap-1.5 rounded-lg border border-white/15 px-3 text-[13.5px] text-slate-200 hover:bg-white/5">
                  <SkipForward size={15} /> Skip
                </button>
              )}
            </div>
          </form>

          <h2 className="mt-5 border-t border-white/10 pt-4 text-[14px] font-semibold text-white">Or start from a scenario</h2>
          <ul className="mt-2.5 space-y-1.5">
            {SAMPLES.map((s) => {
              const [kind, kcls] = KIND[s.id] ?? ['Sample', 'text-slate-300 bg-white/10'];
              const on = sample === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => pick(s)}
                    disabled={running}
                    aria-pressed={on}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-teal-300 disabled:opacity-50 ${
                      on ? 'border-teal-400/60 bg-teal-400/10' : 'border-white/10 hover:border-white/25 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11.5px] font-semibold ${kcls}`}>{kind}</span>
                      <span className="truncate text-[13.5px] font-medium text-white">{s.label.replace(/^[A-Z]{2} · /, '')}</span>
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-slate-400">{s.hint}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Pipeline */}
        <div className="min-w-0 space-y-4">
          <Rail state={state} result={result} />

          {!started && (
            <div className="rounded-2xl border border-dashed border-white/15 px-6 py-16 text-center">
              <p className="text-[16px] font-medium text-white">Write a ticket, or start from a scenario, then run it.</p>
              <p className="mt-1 text-[14px] text-slate-400">Try slipping in an email address, an IBAN or “ignore previous instructions” and watch what the gateway and the gate do.</p>
            </div>
          )}

          {visible(0) && <GatewayCard sent={sent} result={result} reduce={reduce} />}
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            {visible(1) && <LanguageCard t={result} />}
            {visible(2) && <ClassifyCard t={result} />}
          </div>
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            {visible(3) && <RetrieveCard t={result} />}
            {visible(4) && <GateCard t={result} />}
          </div>
          {visible(5) && <DraftCard t={result} reduce={reduce} />}
          {visible(6) && <ValidateCard t={result} />}
          {finished && <Verdict t={result} onAgain={() => {
            composer.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
            bodyRef.current?.focus({ preventScroll: true });
          }} />}

          {started && (
            <p className="text-[12.5px] text-slate-500">
              The engine answered in {result ? ms(result.latency_ms?.total) : '…'}. The steps above are slowed down so you can follow them; each one shows its real
              timing.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ rail

function Rail({ state, result }) {
  const decision = result?.gate.decision;
  const gateTone = decision === 'ESCALATE_ONCALL' ? 'bg-red-500 text-white' : decision === 'HUMAN_REVIEW' ? 'bg-amber-400 text-[#2a1a00]' : 'bg-teal-400 text-[#04211e]';
  return (
    <ol className="thin-scroll sticky top-0 z-10 flex overflow-x-auto rounded-b-2xl border border-white/10 bg-[#0b1d2c]/95 px-4 py-4 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.7)] backdrop-blur" aria-label="Pipeline progress">
      {STAGES.map((s, i) => {
        const st = state(i);
        const Icon = s.icon;
        const done = st === 'done';
        const tone = done ? (s.id === 'gate' ? gateTone : 'bg-teal-400 text-[#04211e]') : st === 'active' ? 'bg-white/10 text-white ring-2 ring-teal-300' : 'bg-white/[0.06] text-slate-500';
        return (
          <li key={s.id} className="flex min-w-[96px] flex-1 items-start" aria-current={st === 'active' ? 'step' : undefined}>
            <div className="flex flex-col items-center gap-1.5 text-center">
              <span className={`relative grid h-11 w-11 place-items-center rounded-full transition-colors duration-300 ${tone}`}>
                {st === 'active' && <span className="absolute inset-0 animate-ping rounded-full bg-teal-300/30" aria-hidden />}
                <Icon size={19} strokeWidth={2.2} aria-hidden />
              </span>
              <span className={`text-[13px] font-medium ${st === 'pending' || st === 'idle' ? 'text-slate-500' : 'text-white'}`}>{s.label}</span>
              <span className="tabular h-4 text-[12px] text-slate-400">{done && result ? ms(result.latency_ms?.[s.id]) : ''}</span>
            </div>
            {i < STAGES.length - 1 && (
              <span className="mx-1 mt-[21px] h-[3px] min-w-4 flex-1 overflow-hidden rounded-full bg-white/10">
                <span className={`block h-full bg-teal-400 transition-[width] duration-500 ${done ? 'w-full' : 'w-0'}`} />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ stage cards

function Card({ i, title, aside, children, className = '' }) {
  const Icon = STAGES[i].icon;
  return (
    <section id={`lab-stage-${i}`} className={`lab-in scroll-mt-32 rounded-2xl border border-white/10 bg-white/[0.035] p-5 ${className}`}>
      <header className="mb-3 flex items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-teal-400/15 text-teal-300"><Icon size={15} aria-hidden /></span>
        <h2 className="text-[15.5px] font-semibold text-white">{title}</h2>
        {aside && <span className="ml-auto text-[13px] text-slate-400">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function GatewayCard({ sent, result, reduce }) {
  const [phase, setPhase] = useState(reduce ? 2 : 0); // 0 found, 1 redacting, 2 replaced
  useEffect(() => {
    if (!result) return undefined;
    if (reduce) {
      setPhase(2);
      return undefined;
    }
    setPhase(0);
    const a = setTimeout(() => setPhase(1), 450);
    const b = setTimeout(() => setPhase(2), 1300);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [result, reduce]);

  const segs = useMemo(() => (result ? alignMasked(sent.body, result.body) : null), [sent, result]);
  const masked = result?.pii.masked ?? [];
  const total = masked.reduce((a, m) => a + m.count, 0);

  return (
    <Card
      i={0}
      title={result ? (total ? `Hid ${total} piece${total > 1 ? 's' : ''} of personal data` : 'No personal data found') : 'Scanning for personal data…'}
      aside={result && phase === 2 ? 'This is all the engine receives' : null}
    >
      <div className={`rounded-xl bg-black/30 px-4 py-3.5 text-[15px] leading-[1.75] text-slate-200 ${result ? '' : 'lab-scan'}`}>
        {!result ? (
          sent.body
        ) : segs ? (
          segs.map((s, k) =>
            s.text != null ? (
              <span key={k}>{s.text}</span>
            ) : phase === 0 ? (
              <mark key={k} className="rounded bg-rose-500/25 px-0.5 text-rose-100 ring-1 ring-rose-400/60">{s.value}</mark>
            ) : phase === 1 ? (
              <span key={k} className="lab-redact px-0.5">{s.value}</span>
            ) : (
              <Token key={k} token={s.token} />
            ),
          )
        ) : (
          result.body.split(TOKEN_SPLIT).map((p, k) => (k % 2 ? <Token key={k} token={p} /> : <span key={k}>{p}</span>))
        )}
      </div>
      {result && phase === 2 && masked.length > 0 && (
        <div className="lab-in mt-3 flex flex-wrap gap-2">
          {masked.map((m) => (
            <span key={m.type} className="rounded-md bg-teal-400/10 px-2 py-1 text-[12.5px] text-teal-200">
              {m.type.toLowerCase()} <b className="tabular font-semibold">×{m.count}</b>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function Token({ token }) {
  return <span className="lab-stamp mx-0.5 inline-block rounded-md bg-teal-400/20 px-1.5 font-mono text-[12.5px] leading-6 font-semibold text-teal-200 ring-1 ring-teal-300/40">{token}</span>;
}

function LanguageCard({ t }) {
  const ok = t.language.supported;
  return (
    <Card i={1} title="Language" aside={ms(t.latency_ms?.language)}>
      <div className="flex items-baseline gap-3">
        <span className="text-[30px] leading-none font-semibold text-white">{LANGUAGES[t.language.code] ?? t.language.code}</span>
        <span className="tabular text-[15px] text-slate-400">{pct(t.language.confidence)} sure</span>
      </div>
      <p className={`mt-2.5 text-[14px] ${ok ? 'text-slate-400' : 'text-amber-200'}`}>
        {ok ? `The reply will be drafted in ${LANGUAGES[t.draft.language] ?? t.draft.language}.` : 'Only English and German are supported, so a person takes this one.'}
      </p>
    </Card>
  );
}

function Bar({ label, value, conf, delay = 0, tone = 'bg-teal-400', note }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[14px]">
        <span className="text-slate-400">{label}</span>
        <span className="tabular text-slate-400">{pct(conf)}</span>
      </div>
      <div className="mt-0.5 text-[16px] font-semibold text-white">{value}</div>
      <div className="mt-1.5 h-2 rounded-full bg-white/10">
        <div className={`lab-grow h-full rounded-full ${tone}`} style={{ width: `${Math.round(conf * 100)}%`, animationDelay: `${delay}ms` }} />
      </div>
      {note && <div className="mt-1 text-[12.5px] text-slate-500">{note}</div>}
    </div>
  );
}

function ClassifyCard({ t }) {
  const c = t.classification;
  const low = (x) => x < GATE_THRESHOLDS.confidenceFloor;
  return (
    <Card i={2} title="Classify" aside={ms(t.latency_ms?.classify)}>
      <div className="space-y-3.5">
        <Bar label="Type" value={c.type.label} conf={c.type.confidence} tone={low(c.type.confidence) ? 'bg-amber-400' : 'bg-teal-400'} />
        <Bar label="Queue" value={c.queue.label} conf={c.queue.confidence} delay={180} tone={low(c.queue.confidence) ? 'bg-amber-400' : 'bg-teal-400'} note={c.queue.k ? `${c.queue.votes} of ${c.queue.k} similar tickets agree` : null} />
        <Bar
          label="Priority"
          value={PRIORITIES[c.priority.label]?.label ?? c.priority.label}
          conf={c.priority.confidence}
          delay={360}
          tone={c.priority.label === 'high' ? 'bg-red-500' : 'bg-teal-400'}
          note={`Chance of high priority ${c.priority.p_high.toFixed(2)}; on-call line is ${GATE_THRESHOLDS.highPriority}`}
        />
      </div>
    </Card>
  );
}

function RetrieveCard({ t }) {
  const route = t.retrieval.route;
  return (
    <Card i={3} title={t.precedents.length ? `Found ${t.precedents.length} similar past tickets` : 'No similar past ticket'} aside={ms(t.latency_ms?.retrieve)}>
      {route.queues.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <span className="text-slate-500">Searched in</span>
          {route.queues.map((q) => (
            <span key={q.queue} className={`rounded px-1.5 py-0.5 ${route.searched.includes(q.queue) ? 'bg-teal-400/15 text-teal-200' : 'bg-white/5 text-slate-500'}`}>{q.queue}</span>
          ))}
          {route.fallback_global && <span className="text-amber-200">then all queues</span>}
        </div>
      )}
      {t.precedents.length === 0 ? (
        <p className="text-[14px] text-slate-400">Nothing in the knowledge base is close enough to quote, so the reply can only be a holding message.</p>
      ) : (
        <ul className="space-y-2.5">
          {t.precedents.map((p, k) => (
            <li key={p.ticket_id} className="lab-in" style={{ animationDelay: `${k * 160}ms` }}>
              <div className="flex items-baseline gap-2 text-[14px]">
                <span className="shrink-0 font-mono text-[12.5px] whitespace-nowrap text-teal-300">{p.ticket_id}</span>
                <span className="truncate text-slate-200">{p.subject}</span>
                <span className="tabular ml-auto shrink-0 font-semibold text-white">{pct(p.similarity)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-white/10">
                <div className="lab-grow h-full rounded-full bg-teal-400/80" style={{ width: `${Math.round(p.similarity * 100)}%`, animationDelay: `${k * 160}ms` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GateCard({ t }) {
  const fired = Object.fromEntries(t.gate.reasons.map((r) => [r.code, r]));
  const d = t.gate.decision;
  const tone = d === 'ESCALATE_ONCALL' ? 'bg-red-500 text-white' : d === 'HUMAN_REVIEW' ? 'bg-amber-400 text-[#2a1a00]' : 'bg-teal-400 text-[#04211e]';
  const STEP = 110;
  return (
    <Card i={4} title="Safety gate: 11 rules" aside={ms(t.latency_ms?.gate)}>
      <ul className="space-y-1">
        {RULES.map(([code, r], k) => {
          const hit = fired[code];
          const p1 = r.severity === 'P1';
          const cls = hit ? (p1 ? 'lab-flare-red bg-red-500/15 ring-1 ring-red-400/50' : 'lab-flare-amber bg-amber-400/10 ring-1 ring-amber-300/40') : 'lab-in';
          return (
            <li key={code} className={`rounded-lg px-2.5 py-1.5 ${cls}`} style={{ animationDelay: `${k * STEP}ms` }}>
              <div className="flex items-center gap-2 text-[13.5px]">
                {hit ? (
                  p1 ? <ShieldAlert size={15} className="shrink-0 text-red-300" /> : <AlertTriangle size={15} className="shrink-0 text-amber-300" />
                ) : (
                  <Check size={15} className="shrink-0 text-slate-500" />
                )}
                <span className={hit ? 'font-semibold text-white' : 'text-slate-400'}>{r.label}</span>
                <span className={`ml-auto text-[11.5px] font-semibold ${hit ? (p1 ? 'text-red-300' : 'text-amber-300') : 'text-slate-600'}`}>{r.severity}</span>
              </div>
              {hit?.detail && <p className="mt-0.5 pl-[23px] text-[12.5px] text-slate-300">{hit.detail}</p>}
            </li>
          );
        })}
      </ul>
      <div className="lab-stamp mt-3 flex items-center gap-2" style={{ animationDelay: `${RULES.length * STEP + 150}ms` }}>
        <span className={`rounded-lg px-3 py-1.5 text-[14px] font-bold ${tone}`}>{DECISIONS[d].label}</span>
        <span className="text-[13px] text-slate-400">
          {t.gate.reasons.length ? `${t.gate.reasons.length} rule${t.gate.reasons.length > 1 ? 's' : ''} fired` : 'All rules passed'}
        </span>
      </div>
    </Card>
  );
}

function useTypewriter(text, duration, enabled) {
  const [n, setN] = useState(enabled ? 0 : text.length);
  useEffect(() => {
    if (!enabled) {
      setN(text.length);
      return undefined;
    }
    let raf;
    const start = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - start) / duration);
      setN(Math.round(k * text.length));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration, enabled]);
  return n;
}

const MODE = { generated: 'Written by the model, grounded in past tickets', extractive: 'Quoted from the best past ticket (model fallback)', holding: 'Holding reply: promises nothing' };

function DraftCard({ t, reduce }) {
  const n = useTypewriter(t.draft.text, 2000, !reduce);
  const typing = n < t.draft.text.length;
  const held = t.gate.decision !== 'AUTO_DRAFT';
  return (
    <Card i={5} title="Reply draft" aside={ms(t.latency_ms?.draft)}>
      <p className="mb-2.5 text-[13px] text-slate-400">
        {MODE[t.draft.mode] ?? t.draft.mode}. {held ? 'Held: it will not be sent until a person accepts the triage.' : 'Ready to send after a quick check.'}
      </p>
      <div className="rounded-xl bg-white px-5 py-4 text-ink shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)]">
        <DraftText text={t.draft.text.slice(0, n)} known={t.precedents.map((p) => p.ticket_id)} />
        {typing && <span className="lab-caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-ink" aria-hidden />}
      </div>
    </Card>
  );
}

function ValidateCard({ t }) {
  const v = t.draft.validation;
  const checks = [
    [v.citations_ok, 'Every citation points to a ticket that was retrieved'],
    [v.numbers_ok, 'Every number and promise appears in a cited ticket'],
    [v.language_ok, 'The reply is in the customer’s language'],
  ];
  return (
    <Card i={6} title={v.passed ? 'Draft checked: nothing made up' : 'Draft failed its checks'} aside={ms(t.latency_ms?.validate)}>
      <ul className="space-y-1.5">
        {checks.map(([ok, label], k) => (
          <li key={label} className="lab-in flex items-center gap-2 text-[14px]" style={{ animationDelay: `${k * 200}ms` }}>
            {ok ? <Check size={16} className="text-teal-300" /> : <X size={16} className="text-red-300" />}
            <span className={ok ? 'text-slate-200' : 'text-red-200'}>{label}</span>
          </li>
        ))}
      </ul>
      {v.issues.length > 0 && <p className="mt-2 text-[13px] text-red-200">{v.issues.join(' ')}</p>}
    </Card>
  );
}

function Verdict({ t, onAgain }) {
  const d = t.gate.decision;
  const p1 = t.gate.reasons.filter((r) => r.severity === 'P1');
  const copy = {
    ESCALATE_ONCALL: {
      title: 'Escalated to on-call',
      text: `${p1.map((r) => REASONS[r.code]?.label ?? r.code).join(' and ')}. The engineer on call is paged now; the reply waits for a person.`,
      cls: 'border-red-400/60 bg-red-500/[0.12]',
      head: 'text-red-200',
    },
    HUMAN_REVIEW: {
      title: 'Held for a person',
      text: `${t.gate.reasons.map((r) => REASONS[r.code]?.label ?? r.code).join(', ')}. Nothing is sent until someone checks it.`,
      cls: 'border-amber-300/60 bg-amber-400/[0.10]',
      head: 'text-amber-200',
    },
    AUTO_DRAFT: {
      title: 'Ready to send',
      text: `All 11 rules passed and the reply quotes ${t.draft.citations.length} past ticket${t.draft.citations.length === 1 ? '' : 's'}. No one had to touch it.`,
      cls: 'border-teal-300/60 bg-teal-400/[0.10]',
      head: 'text-teal-200',
    },
  }[d];
  return (
    <section id="lab-verdict" className={`lab-stamp scroll-mt-32 rounded-2xl border-2 px-6 py-5 ${copy.cls}`}>
      <p className={`text-[28px] leading-tight font-bold tracking-tight ${copy.head}`}>{copy.title}</p>
      <p className="mt-1.5 max-w-[70ch] text-[15px] leading-relaxed text-slate-200">{copy.text}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => go(ticketHref(t.ticket_id))}
          className="flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-[14px] font-semibold text-brand-950 hover:bg-slate-100"
        >
          <ExternalLink size={15} /> Open {t.ticket_id}
        </button>
        <button type="button" onClick={onAgain} className="flex items-center gap-1.5 rounded-lg border border-white/20 px-3.5 py-2 text-[14px] text-white hover:bg-white/5">
          <RotateCcw size={15} /> Try another ticket
        </button>
      </div>
      <p className="mt-3 text-[12.5px] text-slate-400">It is also on Overview with the other tickets from this session.</p>
    </section>
  );
}
