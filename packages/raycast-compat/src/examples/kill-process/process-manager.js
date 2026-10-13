export const SAMPLE_PROCESSES = [
    {
        pid: 14220,
        name: "chrome.exe",
        cpuPercent: 14.5,
        memoryMB: 1845.2,
        user: "User",
        threads: 48,
        path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --enable-features=WebAssembly',
        status: "running"
    },
    {
        pid: 8940,
        name: "Code.exe",
        cpuPercent: 8.2,
        memoryMB: 1220.8,
        user: "User",
        threads: 36,
        path: "C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
        commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" --crash-reporter-id 4a8e2',
        status: "running"
    },
    {
        pid: 21088,
        name: "Docker Desktop.exe",
        cpuPercent: 6.8,
        memoryMB: 2450.0,
        user: "SYSTEM",
        threads: 64,
        path: "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
        commandLine: '"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" --virtualization=wsl2',
        status: "running"
    },
    {
        pid: 15432,
        name: "node.exe",
        cpuPercent: 12.0,
        memoryMB: 890.4,
        user: "User",
        threads: 18,
        path: "C:\\Program Files\\nodejs\\node.exe",
        commandLine: '"C:\\Program Files\\nodejs\\node.exe" ./dist/server.js --port=3000',
        status: "running"
    },
    {
        pid: 7320,
        name: "Teams.exe",
        cpuPercent: 3.1,
        memoryMB: 780.5,
        user: "User",
        threads: 28,
        path: "C:\\Program Files\\WindowsApps\\MicrosoftTeams_24231.512.3106.6573_x64\\msteams.exe",
        commandLine: "msteams.exe --background",
        status: "running"
    },
    {
        pid: 4120,
        name: "slack.exe",
        cpuPercent: 2.5,
        memoryMB: 650.0,
        user: "User",
        threads: 24,
        path: "C:\\Users\\User\\AppData\\Local\\slack\\slack.exe",
        commandLine: '"C:\\Users\\User\\AppData\\Local\\slack\\slack.exe" --startup',
        status: "running"
    },
    {
        pid: 18904,
        name: "python.exe",
        cpuPercent: 22.4,
        memoryMB: 512.3,
        user: "User",
        threads: 8,
        path: "C:\\Python312\\python.exe",
        commandLine: "python.exe train_model.py --epochs 100",
        status: "running"
    },
    {
        pid: 3108,
        name: "explorer.exe",
        cpuPercent: 1.2,
        memoryMB: 320.0,
        user: "User",
        threads: 72,
        path: "C:\\Windows\\explorer.exe",
        commandLine: "C:\\Windows\\explorer.exe",
        status: "running"
    }
];
export function filterAndSortProcesses(processes, query, sortBy) {
    let list = [...processes];
    if (query && query.trim()) {
        const q = query.toLowerCase().trim();
        list = list.filter((p) => p.name.toLowerCase().includes(q) ||
            String(p.pid).includes(q) ||
            p.user.toLowerCase().includes(q));
    }
    list.sort((a, b) => {
        switch (sortBy) {
            case "memory":
                return b.memoryMB - a.memoryMB;
            case "cpu":
                return b.cpuPercent - a.cpuPercent;
            case "name":
                return a.name.localeCompare(b.name);
            case "pid":
                return a.pid - b.pid;
            default:
                return 0;
        }
    });
    return list;
}
