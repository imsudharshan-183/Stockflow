import { useEffect, useRef, useState } from "react";
import { Bot, Send, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { ChatResponse, Role } from "@stockflow/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Turn = { question: string; answer?: ChatResponse; error?: string };
const suggestions: Record<Role, string[]> = {
  admin: ["What needs attention across the network?", "Which products are running low?", "How many products are over BD 200?", "Explain stock cover"],
  manager: ["What needs attention in my stores?", "Show my stock forecast", "Any incoming deliveries?", "Explain net benefit"],
  staff: ["What should I check today?", "Find a product by SKU", "Any deliveries to receive?", "How do I flag a stock issue?"],
};

export function StockChat({ branch, scope, role }: { branch?: string; scope: string; role: Role }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const log = transcript.current;
    if (open && log) log.scrollTop = log.scrollHeight;
  }, [turns, open]);

  async function ask(text: string, retryLast = false) {
    const question = text.trim();
    if (!question || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setDraft("");
    const previous = turns.filter((turn) => turn.answer).at(-1)?.answer?.context;
    setTurns((history) => [...(retryLast ? history.slice(0, -1) : history.slice(-19)), { question }]);
    let turn: Turn;
    try {
      const answer = await api.chat({ question, branchId: branch, previous });
      turn = { question, answer };
    } catch (error) {
      turn = {
        question,
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
        className="flex h-[min(32rem,calc(100dvh-6rem))] w-[min(23rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl p-0"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Bot className="size-5 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">StockFlow</h2>
            <p className="truncate text-xs text-muted-foreground">{scope}</p>
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
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm"
        >
          {turns.length === 0 && (
            <div className="space-y-3">
              <p>Hi, I’m StockFlow. What would you like me to do today?</p>
              <div className="flex flex-wrap gap-2">
                {suggestions[role].map((q) => (
                  <Button key={q} variant="secondary" size="sm" className="h-auto max-w-full whitespace-normal py-1.5 text-left" onClick={() => void ask(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn, i) => (
            <div key={i} className="space-y-2">
              <p className="ml-auto w-fit max-w-[90%] break-words rounded-xl bg-primary-soft px-3 py-2 text-primary-text">
                {turn.question}
              </p>
              {turn.error ? (
                <div role="alert">
                  <p>{turn.error}</p>
                  {i === turns.length - 1 && <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void ask(turn.question, true)}
                  >
                    Try again
                  </Button>}
                </div>
              ) : turn.answer ? (
                <div className="space-y-2">
                  <p>{turn.answer.summary}</p>
                  {turn.answer.facts.length > 0 && (
                    <ul className="divide-y divide-border">
                      {turn.answer.facts.map((fact) => (
                        <li key={fact.id} className="py-1.5">
                          {fact.href ? (
                            <Link
                              to={
                                fact.href.startsWith("#")
                                  ? `/${branch ? "?location=" + encodeURIComponent(branch) : ""}${fact.href}`
                                  : fact.href
                              }
                              className="text-primary underline"
                              onClick={() => setOpen(false)}
                            >
                              {fact.label}
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
                    {turn.answer.source !== "records" ? "AI-assisted lookup" : "Record lookup"} ·{" "}
                    {formatDate(turn.answer.asOf)}
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">Checking stock records…</p>
              )}
            </div>
          ))}
        </div>
        <form
          className="flex items-center gap-2 border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(draft);
          }}
        >
          <Input
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={500}
            aria-label="Ask a stock question"
            placeholder="Ask a stock question…"
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
