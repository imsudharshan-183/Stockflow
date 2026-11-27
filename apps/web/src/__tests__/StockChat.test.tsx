import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { StockChat } from "@/components/shared/StockChat";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { chat: vi.fn() } }));

it("opens from Data Entry and reads fresh sales when the user selects refresh", async () => {
  const user = userEvent.setup();
  const context = { topic: "sales" as const, search: "", branchId: "BR-001" };
  const answer = { source: "records" as const, asOf: "2026-11-27", facts: [], context };
  vi.mocked(api.chat)
    .mockResolvedValueOnce({ ...answer, summary: "This store reported 2 units sold today." })
    .mockResolvedValueOnce({ ...answer, summary: "This store reported 7 units sold today." });
  render(<MemoryRouter initialEntries={["/data?tab=import"]}>
    <StockChat scope="Manama" branch="BR-001" role="staff" />
  </MemoryRouter>);
  await user.click(screen.getByRole("button", { name: "Open stock assistant" }));
  await user.click(screen.getByRole("button", { name: "Summarize today’s sales" }));
  expect(await screen.findByText("This store reported 2 units sold today.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh today’s sales" }));
  expect(await screen.findByText("This store reported 7 units sold today.")).toBeVisible();
  expect(api.chat).toHaveBeenLastCalledWith(expect.objectContaining({ previous: context, branchId: "BR-001", page: "sales" }));
});

it("accepts a replacement cutoff directly from an empty catalog answer", async () => {
  const user = userEvent.setup();
  const context = { topic: "catalog" as const, search: "",
    catalog: { metric: "price" as const, operator: "gt" as const, amount: 200, sort: "sku" as const, view: "count" as const } };
  vi.mocked(api.chat).mockResolvedValue({ source: "records", asOf: "2026-11-27", context, facts: [], summary: "No matching products." });
  render(<MemoryRouter><StockChat scope="All stores" role="admin" /></MemoryRouter>);
  await user.click(screen.getByRole("button", { name: "Open stock assistant" }));
  const input = screen.getByRole("textbox", { name: "Ask a stock question" });
  await user.type(input, "How many products are over BD 200?{Enter}");
  await user.click(await screen.findByRole("button", { name: "Try another price" }));
  expect(input).toHaveFocus();
  await user.type(input, "100{Enter}");
  expect(api.chat).toHaveBeenLastCalledWith(expect.objectContaining({ question: "100", previous: context }));
});
