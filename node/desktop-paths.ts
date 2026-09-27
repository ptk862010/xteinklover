// Phần thuần của bản tải về (không chạy gì khi import): thư mục dữ liệu, IP gợi ý cho máy đọc.
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

export const APP = "Xteink Lover";

/** Thư mục dữ liệu theo thói quen từng hệ điều hành. DATA_DIR ghi đè được. */
export function dataDirFor(platform = process.platform, env = process.env, home = homedir()): string {
  if (env.DATA_DIR) return resolve(env.DATA_DIR);
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), APP);
  if (platform === "darwin") return join(home, "Library", "Application Support", APP);
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "xteink-lover");
}

/** WiFi / LAN nhà trước; card ảo (WSL, Hyper-V, Docker, VPN) và dải 100.64/10 (Tailscale, CGNAT) xuống cuối. */
export function rankAddress(ip: string, iface: string): number {
  if (/vEthernet|WSL|docker|br-|virbr|VirtualBox|VMware|utun|tailscale|zt/i.test(iface)) return 4;
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

/** IP trong mạng nhà (IPv4, không phải loopback) để điền vào máy đọc, cái hợp nhất lên đầu. */
export function lanAddresses(ifaces = networkInterfaces()): string[] {
  return Object.entries(ifaces)
    .flatMap(([name, list]) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ ip: a.address, rank: rankAddress(a.address, name) })))
    .sort((a, b) => a.rank - b.rank)
    .map((a) => a.ip);
}
