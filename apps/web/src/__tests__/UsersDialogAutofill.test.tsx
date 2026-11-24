import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "@/features/auth/LoginPage";
import { UsersPage } from "@/features/users/UsersPage";
import type { User } from "@stockflow/core";

const apiMocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  kpis: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  resetPassword: vi.fn(),
  deactivateUser: vi.fn(),
}));

const authState = vi.hoisted((): { user: User } => ({
  user: {
    id: "usr_admin_1",
    name: "Network Admin",
    email: "admin@stockflow.dev",
    role: "admin",
    branchIds: [],
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => ({
    user: authState.user,
    login: vi.fn(),
    isLoading: false,
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
  useOptionalAuth: () => ({
    user: authState.user,
    login: vi.fn(),
    isLoading: false,
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));

function renderUsersPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UsersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Workstream 4: UsersPage autofill protection, form reset, and validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listUsers.mockResolvedValue({
      users: [
        {
          id: "usr_mgr_1",
          name: "Manama Manager",
          email: "mgr.manama@stockflow.dev",
          role: "manager",
          branchIds: ["BR-001"],
          isActive: true,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    apiMocks.kpis.mockResolvedValue({
      branches: [
        { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
        { id: "BR-002", name: "Manama - Juffair", city: "Manama", region: "Capital", status: "active" },
      ],
      categories: [],
    });
    apiMocks.createUser.mockResolvedValue({
      id: "usr_new_1",
      name: "Dana Al-Bahrani",
      email: "dana@stockflow.dev",
      role: "staff",
      branchIds: ["BR-001"],
      isActive: true,
      createdAt: "2026-11-24T00:00:00.000Z",
    });
    apiMocks.updateUser.mockResolvedValue({
      id: "usr_mgr_1",
      name: "Manama Manager",
      email: "mgr.manama@stockflow.dev",
      role: "manager",
      branchIds: ["BR-001"],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    apiMocks.resetPassword.mockResolvedValue({ ok: true });
  });

  it("sets autofill protections and decoys on Create dialog, resets on cancel & success, and supports Show/Generate password + validation", async () => {
    const user = userEvent.setup();
    renderUsersPage();

    await screen.findByText("Manama Manager");
    await user.click(screen.getByRole("button", { name: /Add user/i }));

    const fullNameInput = (await screen.findByLabelText(/Full name/i)) as HTMLInputElement;
    const emailInput = screen.getByLabelText(/^Email$/i) as HTMLInputElement;
    const passwordInput = screen.getByLabelText(/^Password \(min 8 characters\)$/i) as HTMLInputElement;

    expect(fullNameInput.getAttribute("autocomplete")).toBe("off");
    expect(fullNameInput.name).toBe("newUserFullName");
    expect(fullNameInput.value).toBe("");

    expect(emailInput.type).toBe("email");
    expect(emailInput.getAttribute("autocomplete")).toBe("off");
    expect(emailInput.name).toBe("newUserEmail");
    expect(emailInput.id).not.toBe("email");
    expect(emailInput.id).not.toBe("username");
    expect(emailInput.value).toBe("");

    expect(passwordInput.getAttribute("autocomplete")).toBe("new-password");
    expect(passwordInput.name).toBe("newUserPassword");
    expect(passwordInput.id).not.toBe("password");
    expect(passwordInput.value).toBe("");

    const decoyUser = document.querySelector<HTMLInputElement>('input[name="decoyUsername"]');
    const decoyPass = document.querySelector<HTMLInputElement>('input[name="decoyPassword"]');
    expect(decoyUser?.getAttribute("autocomplete")).toBe("username");
    expect(decoyUser?.tabIndex).toBe(-1);
    expect(decoyUser?.getAttribute("aria-hidden")).toBe("true");
    expect(decoyPass?.getAttribute("autocomplete")).toBe("current-password");

    // Validation rejects plain "admin" email, <8 char password, and 0 assigned branches
    await user.type(fullNameInput, "Admin Test");
    await user.type(emailInput, "admin");
    await user.click(screen.getByRole("button", { name: /^Create user$/i }));
    expect(await screen.findByText(/Enter a valid email address/i)).toBeInTheDocument();

    await user.clear(emailInput);
    await user.type(emailInput, "dana@stockflow.dev");
    await user.type(passwordInput, "short7");
    await user.click(screen.getByRole("button", { name: /^Create user$/i }));
    expect(await screen.findByText(/Password must be at least 8 characters/i)).toBeInTheDocument();

    // Generate password fills >=8 chars and reveals input; Show/Hide password toggles type
    await user.click(screen.getByRole("button", { name: /Generate password/i }));
    expect(passwordInput.value.length).toBeGreaterThanOrEqual(8);
    expect(passwordInput.type).toBe("text");
    await user.click(screen.getByRole("button", { name: /Hide password/i }));
    expect(passwordInput.type).toBe("password");
    await user.click(screen.getByRole("button", { name: /Show password/i }));
    expect(passwordInput.type).toBe("text");

    await user.click(screen.getByRole("button", { name: /^Create user$/i }));
    expect(await screen.findByText(/Select at least one assigned branch/i)).toBeInTheDocument();

    // Cancel and reopen -> completely reset
    await user.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await user.click(screen.getByRole("button", { name: /Add user/i }));
    expect(((await screen.findByLabelText(/Full name/i)) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^Email$/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^Password \(min 8 characters\)$/i) as HTMLInputElement).value).toBe("");

    // Valid submit succeeds and reopening starts fresh again
    await user.type(screen.getByLabelText(/Full name/i), "Dana Al-Bahrani");
    await user.type(screen.getByLabelText(/^Email$/i), "dana@stockflow.dev");
    await user.click(screen.getByRole("button", { name: /Generate password/i }));
    await user.click(screen.getByLabelText(/BR-001/i));
    await user.click(screen.getByRole("button", { name: /^Create user$/i }));

    await waitFor(() => expect(apiMocks.createUser).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole("button", { name: /Add user/i }));
    expect(((await screen.findByLabelText(/Full name/i)) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^Email$/i) as HTMLInputElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: /^Cancel$/i }));
  });

  it("protects Edit User and Reset Password dialogs against autofill while LoginPage allows saved credentials", async () => {
    const user = userEvent.setup();
    renderUsersPage();
    await screen.findByText("Manama Manager");

    await user.click(screen.getByRole("button", { name: /^Edit$/i }));
    const editName = (await screen.findByLabelText(/Full name/i)) as HTMLInputElement;
    expect(editName.getAttribute("autocomplete")).toBe("off");
    expect(editName.name).toBe("editUserFullName");
    expect(document.querySelector('input[name="decoyUsername"]')).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await user.click(screen.getByRole("button", { name: /^Password$/i }));
    const resetInput = (await screen.findByLabelText(/New password \(min 8 characters\)/i)) as HTMLInputElement;
    expect(resetInput.getAttribute("autocomplete")).toBe("new-password");
    expect(resetInput.name).toBe("resetUserPassword");
    expect(resetInput.value).toBe("");
    await user.click(screen.getByRole("button", { name: /^Cancel$/i }));

    const loginRender = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    const loginEmail = loginRender.getByLabelText(/Email address/i) as HTMLInputElement;
    const loginPass = loginRender.getByLabelText(/^Password$/i) as HTMLInputElement;
    expect(loginEmail.getAttribute("autocomplete")).toBe("username");
    expect(loginPass.getAttribute("autocomplete")).toBe("current-password");
  });
});
