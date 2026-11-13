import type { Role } from "@stockflow/core";
import { UserModel, RefreshTokenModel } from "./models.js";
import type { UserRepository, UserRecord, RefreshTokenRecord } from "./userTypes.js";

export class MongoUserRepository implements UserRepository {
  async findByEmail(email: string): Promise<UserRecord | null> {
    const doc = await UserModel.findOne({ email: email.toLowerCase().trim() }).lean();
    if (!doc) return null;
    return this.toRecord(doc);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const doc = await UserModel.findOne({ id }).lean();
    if (!doc) return null;
    return this.toRecord(doc);
  }

  async list(): Promise<UserRecord[]> {
    const docs = await UserModel.find().sort({ createdAt: 1 }).lean();
    return docs.map((doc) => this.toRecord(doc));
  }

  async create(record: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    const id = `usr_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    const createdAt = new Date().toISOString();
    const doc = await UserModel.create({
      ...record,
      id,
      email: record.email.toLowerCase().trim(),
      createdAt,
    });
    return this.toRecord(doc.toObject());
  }

  async update(id: string, updates: Partial<Omit<UserRecord, "id" | "createdAt">>): Promise<UserRecord | null> {
    const doc = await UserModel.findOneAndUpdate(
      { id },
      {
        $set: {
          ...updates,
          ...(updates.email ? { email: updates.email.toLowerCase().trim() } : {}),
        },
      },
      { new: true },
    ).lean();
    if (!doc) return null;
    return this.toRecord(doc);
  }

  async saveRefreshToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    await RefreshTokenModel.create({
      userId,
      token,
      expiresAt,
    });
  }

  async findRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
    const doc = await RefreshTokenModel.findOne({ token }).lean();
    if (!doc) return null;
    return {
      token: doc.token,
      userId: doc.userId,
      expiresAt: doc.expiresAt,
    };
  }

  async deleteRefreshToken(token: string): Promise<void> {
    await RefreshTokenModel.deleteOne({ token });
  }

  async deleteRefreshTokensForUser(userId: string): Promise<void> {
    await RefreshTokenModel.deleteMany({ userId });
  }

  private toRecord(doc: Record<string, unknown>): UserRecord {
    return {
      id: String(doc.id),
      name: String(doc.name),
      email: String(doc.email),
      passwordHash: String(doc.passwordHash),
      role: doc.role as Role,
      branchIds: Array.isArray(doc.branchIds) ? (doc.branchIds as string[]) : [],
      isActive: Boolean(doc.isActive),
      createdAt: String(doc.createdAt),
      lastLoginAt: doc.lastLoginAt ? String(doc.lastLoginAt) : null,
    };
  }
}
