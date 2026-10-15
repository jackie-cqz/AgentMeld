import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { createHash } from "node:crypto";
import { load } from "cheerio";

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(ip, prefix, "ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(ip, prefix, "ipv6");

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !blocked.check(ip, "ipv4");
  return isIP(ip) === 6 && globalV6.check(ip, "ipv6") && !blocked.check(ip, "ipv6");
}

export async function resolvePublicUrl(raw: string) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("Only public HTTP(S) URLs on ports 80/443 without credentials are allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("Private, local, reserved or mixed public/private destinations are blocked. If a proxy uses fake-IP DNS (for example 198.18.0.0/15), configure real public DNS for the AgentMeld server; do not disable this safety check.");
  return { url, address: addresses[0]!.address, family: addresses[0]!.family };
}

// Pin each vetted DNS answer to the connection, and validate each redirect anew.
export async function publicRequest(raw: string, signal: AbortSignal, options: { headers?: Record<string, string>; body?: string; redirects?: number } = {}): Promise<{ url: string; status: number; contentType: string; body: string }> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  let target = raw;
  for (let redirects = 0; ; redirects++) {
    deadline.throwIfAborted();
    const { url, address, family } = await new Promise<Awaited<ReturnType<typeof resolvePublicUrl>>>((resolve, reject) => {
      const abort = () => reject(deadline.reason);
      deadline.addEventListener("abort", abort, { once: true });
      resolvePublicUrl(target).then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort));
    });
    deadline.throwIfAborted();
    const response = await new Promise<{ status: number; location?: string; contentType: string; body: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        method: options.body ? "POST" : "GET", signal: deadline,
        lookup: (_hostname, opts, callback) => opts.all ? callback(null, [{ address, family }]) : callback(null, address, family),
        headers: { "User-Agent": "AgentMeld/1.0", Accept: "text/html,application/json,text/plain", "Accept-Encoding": "identity", ...options.headers },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", chunk => { size += chunk.length; if (size > 1024 * 1024) { res.destroy(new Error("Response exceeds 1 MiB.")); } else chunks.push(Buffer.from(chunk)); });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject); request.end(options.body);
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || options.headers || options.body || redirects >= (options.redirects ?? 3)) throw new Error("Redirect rejected or redirect limit reached.");
      target = new URL(response.location, target).href; continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Remote server returned HTTP ${response.status}.`);
    return { url: url.href, ...response };
  }
}

export function extractWebText(body: string, contentType: string) {
  if (!/text\/|json|xml|xhtml/i.test(contentType)) throw new Error("Only textual web responses are supported.");
  let title = ""; let text = body;
  if (/html/i.test(contentType)) {
    const $ = load(body); title = $("title").text().trim();
    $("script,style,noscript,svg,nav,footer,form,iframe").remove();
    $("br").replaceWith("\n"); $("p,div,section,li,h1,h2,h3,pre,tr").append("\n");
    text = ($("main").first().text() || $("article").first().text() || $("body").text()).replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
  }
  return { title: title.slice(0, 300), content: text.slice(0, 30000), truncated: text.length > 30000,
    contentHash: createHash("sha256").update(body).digest("hex"), retrievedAt: Date.now(), untrusted: true };
}
