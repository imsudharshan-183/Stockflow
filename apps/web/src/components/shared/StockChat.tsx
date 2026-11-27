import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Bot, ChevronRight, MapPin, Send, X } from "lucide-react";
import { Link, useLocation, useMatch } from "react-router-dom";
import type { ChatRequest, ChatResponse, Role } from "@stockflow/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Turn = { request: ChatRequest; answer?: ChatResponse; error?: string };
const sales = "Summarize today’s sales";
const shortages = "Which products are running low?";
const deliveries = "Any deliveries to receive?";
const pricePrompt = "Try another price";
function starters(role: Role, path: string, product: boolean, branch?: string) {
  if (product) return ["How much of this product is on hand?", "Show forecast for this product", shortages];
  if (path === "/data") return [sales, shortages, deliveries];
  if (path === "/products") return [shortages, "Find a product by SKU", sales];
  if (path === "/queue") return ["Which transfers are awaiting release?", deliveries, shortages];
  if (role === "staff") return [shortages, deliveries, sales];
  return [branch ? "What needs attention in this store?" : "What needs attention across my stores?", sales, shortages];
}

function nextQuestions(answer: ChatResponse, role: Role) {
  const { topic, catalog, firstItem } = answer.context;
  if (topic === "sales") return ["Refresh today’s sales", shortages];
  if (topic === "shortages") return firstItem ? ["Why is the first item at risk?", deliveries] : [deliveries, sales];
  if (topic === "catalog" && catalog?.metric === "price" && role !== "staff" && catalog.operator !== "any")
    return ["See highest-priced products", pricePrompt];
  return [shortages, sales];
}

export function StockChat({ branch, scope, role }: { branch?: string; scope: string; role: Role }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [enterPrice, setEnterPrice] = useState(false);
  const { pathname } = useLocation();
  const productSku = useMatch("/products/:sku")?.params.sku;
  const inFlight = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const log = transcript.current;
    const last = log?.lastElementChild;
    if (open && log && last instanceof HTMLElement) log.scrollTop = Math.max(0, last.offsetTop - 16);
  }, [turns, open]);

  async function ask(text: string, mode?: "followUp" | "retry") {
    const question = text.trim();
    if (!question || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setEnterPrice(false);
    setDraft("");
    const previous = turns.filter((turn) => turn.answer).at(-1)?.answer?.context;
    const request: ChatRequest = (mode === "retry" && turns.at(-1)?.request) || {
      question,
      branchId: branch ?? (mode === "followUp" ? previous?.branchId : undefined),
      previous, productSku, page: pathname === "/data" ? "sales" : undefined,
    };
    setTurns((history) => [...(mode === "retry" ? history.slice(0, -1) : history.slice(-19)), { request }]);
    let turn: Turn;
    try {
      const answer = await api.chat(request);
      turn = { request, answer };
    } catch (error) {
      turn = {
        request,
        error: error instanceof Error ? error.message : "Could not load stock records.",
      };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    setTurns((history) => [...history.slice(0, -1), turn]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="primary"
            size="icon"
            aria-label="Open stock assistant"
            title="Ask StockFlow"
            className="fixed bottom-4 right-4 z-40 size-11 rounded-2xl shadow-pop sm:bottom-6 sm:right-6"
          />
        }
      >
        <Bot className="size-6" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        initialFocus={input}
        aria-label="Stock assistant"
        className="flex h-[calc(100dvh-5rem)] max-h-[var(--available-height)] w-[min(29rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl p-0 sm:h-auto sm:max-h-[min(38rem,var(--available-height),calc(100dvh-6rem))]"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="grid size-9 place-items-center rounded-xl bg-primary-soft text-primary-text"><Bot className="size-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">StockFlow</h2>
            <p className="flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="size-3" aria-hidden="true" />{scope}</p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close stock assistant"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </header>
        <div
          ref={transcript}
          role="log"
          aria-label="Stock conversation"
          aria-live="polite"
          className="relative min-h-0 flex-auto space-y-5 overflow-y-auto p-4 text-sm"
        >
          {turns.length === 0 && (
            <div className="space-y-3">
              <p>Hi, I’m StockFlow. What would you like me to do today?</p>
              <div className="grid gap-2">
                {starters(role, pathname, Boolean(productSku), branch).map((q) => (
                  <Button key={q} variant="secondary" size="sm" className="h-auto justify-between whitespace-normal rounded-xl px-3 py-2.5 text-left" onClick={() => void ask(q)}>
                    {q}<ChevronRight aria-hidden="true" />
                  </Button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn, i) => (
            <div key={i} className="space-y-2">
              <p className="ml-auto w-fit max-w-[90%] break-words rounded-xl bg-primary-soft px-3 py-2 text-primary-text">
                {turn.request.question}
              </p>
              {turn.error ? (
                <div role="alert">
                  <p>{turn.error}</p>
                  {i === turns.length - 1 && <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void ask(turn.request.question, "retry")}
                  >
                    Try again
                  </Button>}
                </div>
              ) : turn.answer ? (
                <div className="space-y-3">
                  <p className="font-medium leading-relaxed">{turn.answer.summary}</p>
                  {turn.answer.facts.length > 0 && (
                    <ul className="divide-y divide-border rounded-xl border border-border bg-card px-3">
                      {turn.answer.facts.map((fact) => (
                        <li key={fact.id} className="space-y-0.5 py-2">
                          {fact.href ? (
                            <Link
                              to={
                                fact.href.startsWith("#")
                                  ? `/${branch ? "?location=" + encodeURIComponent(branch) : ""}${fact.href}`
                                  : fact.href
                              }
                              className="text-primary hover:underline"
                              onClick={() => setOpen(false)}
                            >
                              {fact.label} <ArrowUpRight className="inline size-3" aria-hidden="true" />
                            </Link>
                          ) : (
                            <span>{fact.label}</span>
                          )}
                          <span className="block text-xs tabular-nums text-muted-foreground">
                            {fact.value}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {turn.answer.context.topic === "sales" ? "Reported sales · Bahrain" : turn.answer.source === "records" ? "StockFlow records" : "AI-assisted lookup"} ·{" "}
                    {formatDate(turn.answer.asOf)}
                  </p>
                  {i === turns.length - 1 && <div className="flex flex-wrap gap-1.5" aria-label="Follow-up questions">
                    {nextQuestions(turn.answer, role).map((question) => (
                      <Button key={question} size="sm" variant="outline" className="h-auto whitespace-normal py-1.5"
                        onClick={() => {
                          if (question === pricePrompt) {
                            setEnterPrice(true);
                            input.current?.focus();
                          } else void ask(question, "followUp");
                        }}>
                        {question}
                      </Button>
                    ))}
                  </div>}
                </div>
              ) : (
                <p className="text-muted-foreground">Checking stock records…</p>
              )}
            </div>
          ))}
        </div>
        {enterPrice && <label htmlFor="stock-chat-question" className="px-4 pt-2 text-sm">What price in BD should I use?</label>}
        <form
          className="flex items-center gap-2 border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(draft);
          }}
        >
          <Input
            id="stock-chat-question"
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={500}
            aria-label="Ask a stock question"
            placeholder={enterPrice ? "Enter a price in BD…" : turns.length ? "Ask a follow-up…" : "Ask a stock question…"}
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send question"
            disabled={busy || !draft.trim()}
          >
            <Send />
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
