import ipaddr from "ipaddr.js";
import { networkInterfaces } from "node:os";
import type { IncomingHttpHeaders } from "node:http";
export interface Identity {
  ip: string;
  local: boolean;
  directLoopback: boolean;
  proxied: boolean;
}
export function normalizeIp(input: string): string {
  const parsed = ipaddr.process(input.split("%")[0]);
  return parsed.toString();
}
export const loopback = (ip: string) =>
  ipaddr.process(ip).range() === "loopback";
export function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) =>
    (list ?? []).map((i) => normalizeIp(i.address)),
  );
}
export function resolveIdentity(
  raw: string,
  headers: IncomingHttpHeaders,
  trust: string[],
  locals = localAddresses(),
): Identity {
  const peer = normalizeIp(raw);
  const proxied = [
    "forwarded",
    "x-real-ip",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ].some((k) => headers[k] !== undefined);
  let ip = peer;
  if (proxied && trust.some((t) => normalizeIp(t) === peer)) {
    const real = headers["x-real-ip"];
    if (typeof real !== "string" || !ipaddr.isValid(real))
      throw new Error("可信代理必须覆盖设置有效的 X-Real-IP");
    ip = normalizeIp(real);
  }
  return {
    ip,
    proxied,
    local: loopback(ip) || locals.map(normalizeIp).includes(ip),
    directLoopback: loopback(peer) && !proxied,
  };
}
