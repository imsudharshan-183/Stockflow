import type { UserRepository, UserRecord, RefreshTokenRecord } from "./userTypes.js";
import { getInitialSeedUsers } from "./seedData.js";

export class InMemoryUserRepository implements UserRepository {
  private readonly users: Map<string, UserRecord> = new Map();
  private readonly refreshTokens: Map<string, RefreshTokenRecord> = new Map();

  constructor(initialUsers: UserRecord[] = getInitialSeedUsers()) {
    for (const u of initialUsers) {
      this.users.set(u.id, { ...u });
    }
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.toLowerCase().trim();
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === normalized) {
        return Promise.resolve({ ...user });
      }
    }
    return Promise.resolve(null);
  }

  findById(id: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    return Promise.resolve(user ? { ...user } : null);
  }

  list(): Promise<UserRecord[]> {
    return Promise.resolve(Array.from(this.users.values()).map((u) => ({ ...u })));
  }

  create(record: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    const id = `usr_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    const createdAt = new Date().toISOString();
    const newUser: UserRecord = {
      ...record,
      id,
      email: record.email.toLowerCase().trim(),
      createdAt,
    };
    this.users.set(id, newUser);
    return Promise.resolve({ ...newUser });
  }

  update(id: string, updates: Partial<Omit<UserRecord, "id" | "createdAt">>): Promise<UserRecord | null> {
    const existing = this.users.get(id);
    if (!existing) return Promise.resolve(null);
    const updated: UserRecord = {
      ...existing,
      ...updates,
      email: updates.email ? updates.email.toLowerCase().trim() : existing.email,
    };
    this.users.set(id, updated);
    return Promise.resolve({ ...updated });
  }

  saveRefreshToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    this.refreshTokens.set(token, { token, userId, expiresAt });
    return Promise.resolve();
  }

  findRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
    const record = this.refreshTokens.get(token);
    if (!record) return Promise.resolve(null);
    if (record.expiresAt.getTime() < Date.now()) {
      this.refreshTokens.delete(token);
      return Promise.resolve(null);
    }
    return Promise.resolve({ ...record });
  }

  deleteRefreshToken(token: string): Promise<void> {
    this.refreshTokens.delete(token);
    return Promise.resolve();
  }

  deleteRefreshTokensForUser(userId: string): Promise<void> {
    for (const [t, r] of this.refreshTokens.entries()) {
      if (r.userId === userId) {
        this.refreshTokens.delete(t);
      }
    }
    return Promise.resolve();
  }
}
