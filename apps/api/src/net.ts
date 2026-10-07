/**
 * Minimal IP / CIDR matching for RATE_LIMIT_EXEMPT_IPS (v5, agent D). Handles dotted IPv4,
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) and plain IPv6 with `::` compression. Anything that does
 * not parse never matches, so a bad entry fails closed (the limit still applies).
 */

type Parsed = { bits: bigint; width: 32 | 128 };

export function parseIpList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** True when `ip` is one of the entries or inside one of the CIDR ranges. */
export function ipMatches(ip: string, entries: readonly string[]): boolean {
  const candidate = parseIp(ip);
  if (!candidate) return false;
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const address = parseIp(slash < 0 ? entry : entry.slice(0, slash));
    if (!address || address.width !== candidate.width) continue;
    const prefix = slash < 0 ? address.width : Number(entry.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.width) continue;
    const shift = BigInt(address.width - prefix);
    if (candidate.bits >> shift === address.bits >> shift) return true;
  }
  return false;
}

function parseIp(raw: string): Parsed | null {
  const text = raw.trim();
  if (text.includes(":")) return parseIpv6(text);
  const v4 = parseIpv4(text);
  return v4 === null ? null : { bits: v4, width: 32 };
}

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let bits = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bits = (bits << 8n) | BigInt(value);
  }
  return bits;
}

function parseIpv6(text: string): Parsed | null {
  let body = text;
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  const zone = body.indexOf("%");
  if (zone >= 0) body = body.slice(0, zone);
  // IPv4-mapped: compare as IPv4 so `::ffff:10.0.0.1` matches a `10.0.0.0/8` entry.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(body);
  if (mapped && mapped[1]) {
    const v4 = parseIpv4(mapped[1]);
    return v4 === null ? null : { bits: v4, width: 32 };
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
  if (groups.length !== 8) return null;
  let bits = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    bits = (bits << 16n) | BigInt(parseInt(group, 16));
  }
  return { bits, width: 128 };
}
