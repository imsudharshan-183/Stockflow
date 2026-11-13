import crypto from "node:crypto";
import bcryptjs from "bcryptjs";
import { UserSchema, type User } from "@stockflow/core";
import type { UserRepository, UserRecord } from "../repositories/userTypes.js";

const DEFAULT_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function toPublicUser(record: UserRecord): User {
  return UserSchema.parse({
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    branchIds: record.branchIds,
    isActive: record.isActive,
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt ?? null,
  });
}

export class AuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly refreshTtlMs: number = DEFAULT_REFRESH_TTL_MS,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return bcryptjs.hash(password, 10);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcryptjs.compare(password, hash);
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ user: User; refreshToken: string; expiresAt: Date }> {
    const userRecord = await this.userRepo.findByEmail(email);
    if (!userRecord) {
      throw new AuthError("Invalid credentials", 401);
    }

    const isValid = await this.verifyPassword(password, userRecord.passwordHash);
    if (!isValid) {
      throw new AuthError("Invalid credentials", 401);
    }

    if (!userRecord.isActive) {
      throw new AuthError("Account is deactivated", 403);
    }

    const refreshToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    await this.userRepo.saveRefreshToken(userRecord.id, refreshToken, expiresAt);

    const now = new Date().toISOString();
    await this.userRepo.update(userRecord.id, { lastLoginAt: now });
    userRecord.lastLoginAt = now;

    return {
      user: toPublicUser(userRecord),
      refreshToken,
      expiresAt,
    };
  }

  async refresh(
    refreshToken: string,
  ): Promise<{ user: User; newRefreshToken: string; expiresAt: Date }> {
    if (!refreshToken) {
      throw new AuthError("Refresh token required", 401);
    }

    const record = await this.userRepo.findRefreshToken(refreshToken);
    if (!record) {
      throw new AuthError("Invalid or expired refresh token", 401);
    }

    const userRecord = await this.userRepo.findById(record.userId);
    if (!userRecord || !userRecord.isActive) {
      await this.userRepo.deleteRefreshToken(refreshToken);
      throw new AuthError("Unauthorized", 401);
    }

    // Token rotation: delete old, generate new
    await this.userRepo.deleteRefreshToken(refreshToken);

    const newRefreshToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    await this.userRepo.saveRefreshToken(userRecord.id, newRefreshToken, expiresAt);

    return {
      user: toPublicUser(userRecord),
      newRefreshToken,
      expiresAt,
    };
  }

  async logout(refreshToken?: string): Promise<void> {
    if (refreshToken) {
      await this.userRepo.deleteRefreshToken(refreshToken);
    }
  }

  async getUserById(id: string): Promise<User | null> {
    const record = await this.userRepo.findById(id);
    if (!record) return null;
    return toPublicUser(record);
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
