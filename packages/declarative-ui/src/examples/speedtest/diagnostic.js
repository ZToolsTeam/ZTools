export function runNetworkDiagnostics() {
    const local = {
        interfaceName: "Ethernet / Realtek PCIe GbE Family Controller",
        ip: "192.168.1.108",
        subnetMask: "255.255.255.0",
        gateway: "192.168.1.1",
        mac: "00:1A:2B:3C:4D:5E"
    };
    const publicIp = {
        ip: "183.14.132.88",
        isp: "China Telecom (中国电信)",
        asn: "AS4134 CHINANET-BACKBONE",
        country: "China (中国)",
        city: "Shenzhen (深圳)",
        timezone: "Asia/Shanghai (UTC+8)"
    };
    const dnsList = [
        { name: "AliDNS (阿里公共 DNS)", ip: "223.5.5.5", latencyMs: 8, status: "fast", location: "国内多线 BGP" },
        { name: "Tencent DNSPod", ip: "119.29.29.29", latencyMs: 11, status: "fast", location: "国内腾讯云节点" },
        { name: "114 DNS", ip: "114.114.114.114", latencyMs: 14, status: "fast", location: "南京/全国电信联通" },
        { name: "Cloudflare DNS", ip: "1.1.1.1", latencyMs: 38, status: "medium", location: "Anycast 香港节点" },
        { name: "Google Public DNS", ip: "8.8.8.8", latencyMs: 42, status: "medium", location: "Anycast 亚太节点" },
        { name: "OpenDNS", ip: "208.67.222.222", latencyMs: 65, status: "slow", location: "北美/全球节点" }
    ];
    const speed = {
        pingMs: 12,
        jitterMs: 1.8,
        downloadMbps: 685.4,
        uploadMbps: 82.5,
        packetLossPercent: 0.0,
        timestamp: new Date().toLocaleTimeString()
    };
    return { local, publicIp, dnsList, speed };
}
export function generateAsciiBar(value, max, length = 16) {
    const filled = Math.min(length, Math.max(0, Math.round((value / max) * length)));
    return "█".repeat(filled) + "░".repeat(length - filled);
}
