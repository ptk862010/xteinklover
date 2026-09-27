// Bản tải về (node/desktop.ts): thư mục dữ liệu theo hệ điều hành, thứ tự IP gợi ý cho máy đọc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dataDirFor, lanAddresses, rankAddress } from "../node/desktop-paths";

test("thư mục dữ liệu: Windows %APPDATA%, macOS Application Support, Linux XDG; DATA_DIR thắng", () => {
  assert.equal(dataDirFor("win32", { APPDATA: "C:\Users\k\AppData\Roaming" }, "C:\Users\k"), join("C:\Users\k\AppData\Roaming", "Xteink Lover"));
  assert.equal(dataDirFor("darwin", {}, "/Users/k"), join("/Users/k", "Library", "Application Support", "Xteink Lover"));
  assert.equal(dataDirFor("linux", {}, "/home/k"), join("/home/k", ".local", "share", "xteink-lover"));
  assert.equal(dataDirFor("linux", { XDG_DATA_HOME: "/data/x" }, "/home/k"), join("/data/x", "xteink-lover"));
  assert.ok(dataDirFor("win32", { DATA_DIR: "D:\sach" }).endsWith("sach"));
});

test("IP gợi ý: WiFi nhà lên đầu, card ảo (WSL/Hyper-V) và Tailscale xuống cuối", () => {
  const nic = (address: string) => ({ address, family: "IPv4" as const, internal: false, netmask: "", mac: "", cidr: null });
  const ifaces = {
    Tailscale: [nic("100.100.1.2")],
    "vEthernet (WSL)": [nic("172.18.144.1")],
    "Wi-Fi": [nic("192.168.0.100")],
    Loopback: [{ ...nic("127.0.0.1"), internal: true }],
  };
  assert.deepEqual(lanAddresses(ifaces as never), ["192.168.0.100", "100.100.1.2", "172.18.144.1"]);
  assert.equal(rankAddress("10.0.0.5", "eth0"), 1);
  assert.equal(rankAddress("192.168.1.2", "docker0"), 4);
});
