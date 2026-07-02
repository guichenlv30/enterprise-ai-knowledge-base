import type { NextFunction, Request, Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { appConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { store } from "./store.js";
import type { AuthUser, KnowledgeBase, User } from "./models.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function publicUser(user: User): AuthUser {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    departmentId: user.departmentId,
    role: user.role
  };
}

export async function verifyPassword(password: string, user: User): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash);
}

export function createToken(user: User): string {
  const options: SignOptions = { expiresIn: appConfig.auth.accessTokenTtl as SignOptions["expiresIn"] };
  return jwt.sign(publicUser(user), appConfig.jwtSecret, options);
}

function tokenHash(tokenId: string): string {
  return createHash("sha256").update(tokenId).digest("hex");
}

function decodeRefreshTokenId(refreshToken: string): string | undefined {
  const decoded = jwt.decode(refreshToken) as { jti?: string } | null;
  return decoded?.jti;
}

function refreshTokenExpiresAt(token: string): string {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

export function createRefreshToken(user: User): string {
  const tokenId = randomUUID();
  const options: SignOptions = { expiresIn: appConfig.auth.refreshTokenTtl as SignOptions["expiresIn"] };
  const token = jwt.sign(
    {
      type: "refresh",
      sub: String(user.id),
      jti: tokenId
    },
    appConfig.jwtRefreshSecret,
    options
  );
  store.data.refreshTokens ??= [];
  store.data.refreshTokens.push({
    id: store.nextId("refreshToken"),
    userId: user.id,
    tokenHash: tokenHash(tokenId),
    expiresAt: refreshTokenExpiresAt(token),
    createdAt: new Date().toISOString()
  });
  return token;
}

export function refreshAccessToken(refreshToken: string): { token: string; accessToken: string; refreshToken: string; expiresIn: number; user: AuthUser } {
  if (!refreshToken) throw new HttpError(401, "缺少刷新令牌");
  try {
    const payload = jwt.verify(refreshToken, appConfig.jwtRefreshSecret) as { type?: string; sub?: string; jti?: string };
    if (payload.type !== "refresh" || !payload.sub || !payload.jti) throw new HttpError(401, "刷新令牌无效");
    const tokenId = payload.jti;
    const record = store.data.refreshTokens?.find((item) => item.tokenHash === tokenHash(tokenId));
    if (!record || record.revokedAt || record.expiresAt <= new Date().toISOString()) {
      throw new HttpError(401, "刷新令牌无效或已过期");
    }
    const userId = Number(payload.sub);
    const user = store.data.users.find((item) => item.id === userId && item.status === 1);
    if (!user) throw new HttpError(401, "登录已失效");
    const accessToken = createToken(user);
    const nextRefreshToken = createRefreshToken(user);
    const nextTokenId = decodeRefreshTokenId(nextRefreshToken);
    record.revokedAt = new Date().toISOString();
    record.replacedByTokenHash = nextTokenId ? tokenHash(nextTokenId) : undefined;
    pruneRefreshTokens();
    store.save();
    return {
      token: accessToken,
      accessToken,
      refreshToken: nextRefreshToken,
      expiresIn: appConfig.auth.accessTokenExpiresInSeconds,
      user: publicUser(user)
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "刷新令牌无效或已过期");
  }
}

export function revokeRefreshToken(refreshToken: string): boolean {
  const tokenId = decodeRefreshTokenId(refreshToken);
  if (!tokenId) return false;
  const record = store.data.refreshTokens?.find((item) => item.tokenHash === tokenHash(tokenId));
  if (!record || record.revokedAt) return false;
  record.revokedAt = new Date().toISOString();
  store.save();
  return true;
}

function pruneRefreshTokens(): void {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  store.data.refreshTokens = (store.data.refreshTokens ?? []).filter((token) => token.expiresAt >= cutoff || !token.revokedAt);
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new HttpError(401, "请先登录");

  try {
    const payload = jwt.verify(token, appConfig.jwtSecret) as AuthUser;
    const user = store.data.users.find((item) => item.id === payload.id && item.status === 1);
    if (!user) throw new HttpError(401, "登录已失效");
    req.user = publicUser(user);
    next();
  } catch {
    throw new HttpError(401, "登录已失效");
  }
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, "请先登录");
  return req.user;
}

export function canAccessKb(user: AuthUser, kb: KnowledgeBase): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  if (user.role === "USER") return kb.visibility === "PRIVATE" && kb.ownerId === user.id;
  if (kb.visibility === "PUBLIC") return true;
  if (kb.ownerId === user.id) return true;
  if (kb.visibility === "DEPARTMENT") return Boolean(kb.departmentId && user.departmentId === kb.departmentId);
  if (kb.visibility === "MEMBERS") {
    return store.data.kbMembers.some((member) => member.kbId === kb.id && member.userId === user.id);
  }
  return false;
}

export function canManageKb(user: AuthUser, kb: KnowledgeBase): boolean {
  if (user.role === "SUPER_ADMIN" || kb.ownerId === user.id) return true;
  if (user.role === "USER") return false;
  if (user.role === "KB_ADMIN" && (!kb.departmentId || user.departmentId === kb.departmentId)) return true;
  return store.data.kbMembers.some(
    (member) => member.kbId === kb.id && member.userId === user.id && member.permission === "manage"
  );
}

export function requireAdmin(user: AuthUser): void {
  if (user.role !== "SUPER_ADMIN") {
    throw new HttpError(403, "需要超级管理员权限");
  }
}
