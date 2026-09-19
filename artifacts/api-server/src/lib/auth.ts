import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";

const COOKIE_NAME = "quant_session";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "local-development-session-secret";

type CookieRequest = Request & {
  cookies?: Record<string, string>;
};

export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function sessionValue(userId: number): string {
  const id = String(userId);
  const signature = createHmac("sha256", SESSION_SECRET).update(id).digest("hex");
  return `${id}.${signature}`;
}

function userIdFromSession(value: string | undefined): number | null {
  if (!value) return null;
  const [rawId, signature] = value.split(".");
  const userId = Number(rawId);
  if (!Number.isInteger(userId) || userId <= 0 || !signature) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(String(userId)).digest("hex");
  const provided = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    return null;
  }
  return userId;
}

export function setSession(res: Response, userId: number): void {
  res.cookie(COOKIE_NAME, sessionValue(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: "/",
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", path: "/" });
}

export async function getCurrentUser(req: Request): Promise<User | null> {
  const userId = userIdFromSession((req as CookieRequest).cookies?.[COOKIE_NAME]);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return user ?? null;
}