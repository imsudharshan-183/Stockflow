import type { Role } from "@stockflow/core";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  branchIds: string[];
  isActive: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface RefreshTokenRecord {
  token: string;
  userId: string;
  expiresAt: Date;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  list(): Promise<UserRecord[]>;
  create(record: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord>;
  update(id: string, updates: Partial<Omit<UserRecord, "id" | "createdAt">>): Promise<UserRecord | null>;
  saveRefreshToken(userId: string, token: string, expiresAt: Date): Promise<void>;
  findRefreshToken(token: string): Promise<RefreshTokenRecord | null>;
  deleteRefreshToken(token: string): Promise<void>;
  deleteRefreshTokensForUser(userId: string): Promise<void>;
}
