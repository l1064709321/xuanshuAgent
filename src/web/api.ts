// ========== 后端 API 调用封装 ==========
import { state } from "./state.js";

async function request<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  const auth = state.authToken;
  if (auth) headers["Authorization"] = "Bearer " + auth;
  if (init?.body && typeof init.body === "string") headers["Content-Type"] = "application/json";
  const r = await fetch(state.API + url, { ...init, headers });
  return (await r.json()) as T;
}

export function postJSON<T = unknown>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function get<T = unknown>(url: string): Promise<T> {
  return request<T>(url, { method: "GET" });
}

export function authHeaders(): Record<string, string> {
  return state.authToken ? { Authorization: "Bearer " + state.authToken } : {};
}
