import type { UserRepository, UserRecord, RefreshTokenRecord } from "./userTypes.js";
import { getInitialSeedUsers } from "./seedData.js";

export class InMemoryUserRepository implements UserRepository {
  private readonly users: Map<string, UserRecord> = new Map();
  private readonly refreshTokens: Map<string, RefreshTokenRecord> = new Map();
  private initialized = false;
  private readonly customInitialUsers?: UserRecord[];

  constructor(initialUsers?: UserRecord[]) {
    this.customInitialUsers = initialUsers;
    if (initialUsers) {
      for (const u of initialUsers) {
        this.users.set(u.id, { ...u });
      }
      this.initialized = true;
    }
  }

  private ensureUsers(): Map<string, UserRecord> {
    if (!this.initialized) {
      for (const u of this.customInitialUsers ?? getInitialSeedUsers()) {
        this.users.set(u.id, { ...u });
      }
      this.initialized = true;
    }
    return this.users;
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.toLowerCase().trim();
    for (const user of this.ensureUsers().values()) {
      if (user.email.toLowerCase() === normalized) {
        return Promise.resolve({ ...user });
      }
    }
    return Promise.resolve(null);
  }

  findById(id: string): Promise<UserRecord | null> {
    const user = this.ensureUsers().get(id);
    return Promise.resolve(user ? { ...user } : null);
  }

  list(): Promise<UserRecord[]> {
    return Promise.resolve(Array.from(this.ensureUsers().values()).map((u) => ({ ...u })));
  }

  create(record: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    const users = this.ensureUsers();
    const id = `usr_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    const createdAt = new Date().toISOString();
    const newUser: UserRecord = {
      ...record,
      id,
      email: record.email.toLowerCase().trim(),
      createdAt,
    };
    users.set(id, newUser);
    return Promise.resolve({ ...newUser });
  }

  update(id: string, updates: Partial<Omit<UserRecord, "id" | "createdAt">>): Promise<UserRecord | null> {
    const users = this.ensureUsers();
    const existing = users.get(id);
    if (!existing) return Promise.resolve(null);
    const updated: UserRecord = {
      ...existing,
      ...updates,
      email: updates.email ? updates.email.toLowerCase().trim() : existing.email,
    };
    users.set(id, updated);
    return Promise.resolve({ ...updated });
  }

  saveRefreshToken(userId: string, token: string, expiresAt: Date, familyId = token): Promise<void> {
    this.refreshTokens.set(token, { token, userId, familyId, revokedAt: null, expiresAt });
    return Promise.resolve();
  }

  findRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
    const record = this.refreshTokens.get(token);
    if (!record) return Promise.resolve(null);
    if (record.expiresAt.getTime() < Date.now()) {
      this.refreshTokens.delete(token);
      return Promise.resolve(null);
    }
    return Promise.resolve({ ...record, familyId: record.familyId ?? record.token });
  }

  revokeRefreshToken(token: string): Promise<void> {
    const existing = this.refreshTokens.get(token);
    if (existing && !existing.revokedAt) {
      this.refreshTokens.set(token, { ...existing, revokedAt: new Date() });
    }
    return Promise.resolve();
  }

  revokeRefreshTokenFamily(familyId: string): Promise<void> {
    const now = new Date();
    for (const [t, r] of this.refreshTokens.entries()) {
      if ((r.familyId ?? r.token) === familyId && !r.revokedAt) {
        this.refreshTokens.set(t, { ...r, revokedAt: now });
      }
    }
    return Promise.resolve();
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
