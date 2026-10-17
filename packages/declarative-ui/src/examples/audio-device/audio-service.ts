/**
 * 音频设备一键切换核心服务 (audio-service.ts)
 *
 * 直接借鉴 Raycast 官方 `extensions/audio-device/src/audio-device.ts` 源码改造：
 * - 完整保留原版 API 函数签名：`getAllDevices`, `getInputDevices`, `getOutputDevices`,
 *   `getDefaultOutputDevice`, `getDefaultInputDevice`, `setDefaultOutputDevice`, `setDefaultInputDevice`,
 *   `setOutputDeviceVolume`, `toggleOutputDeviceMute`, `setInputDeviceVolume`, `toggleInputDeviceMute`
 * - 增强 Windows CoreAudio / PowerShell 与 macOS `SwitchAudioSource` 双端命令生成
 * - 新增常用场景组合 (Audio Combo Presets: 如会议耳机模式 vs 桌面音响外放模式) 一键切换
 */

import {
  AudioActionResult,
  AudioComboPreset,
  AudioDevice,
  AudioFilterOptions,
  AudioPlatform,
  AudioPlatformCommand,
  IOType,
  TransportType
} from "./types.js";

export const INITIAL_AUDIO_DEVICES: readonly AudioDevice[] = Object.freeze([
  {
    id: "out-bluetooth-airpods",
    uid: "{0.0.0.00000000}.{airpods-pro-out}",
    name: "AirPods Pro (蓝牙降噪耳机)",
    type: "output",
    isInput: false,
    isOutput: true,
    isDefault: true,
    isCommunicationDefault: true,
    volume: 65,
    isMuted: false,
    transportType: TransportType.Bluetooth,
    sampleRate: 48000,
    channels: 2,
    isFavourite: true,
    isHidden: false
  },
  {
    id: "out-display-dell-4k",
    uid: "{0.0.0.00000000}.{dell-u2723qe-dp}",
    name: "Dell U2723QE (外接显示器音响)",
    type: "output",
    isInput: false,
    isOutput: true,
    isDefault: false,
    isCommunicationDefault: false,
    volume: 50,
    isMuted: false,
    transportType: TransportType.DisplayPort,
    sampleRate: 48000,
    channels: 2,
    isFavourite: true,
    isHidden: false
  },
  {
    id: "out-builtin-realtek",
    uid: "{0.0.0.00000000}.{realtek-hd-speakers}",
    name: "Realtek High Definition Audio (本机扬声器)",
    type: "output",
    isInput: false,
    isOutput: true,
    isDefault: false,
    isCommunicationDefault: false,
    volume: 80,
    isMuted: false,
    transportType: TransportType.BuiltIn,
    sampleRate: 48000,
    channels: 2,
    isFavourite: false,
    isHidden: false
  },
  {
    id: "out-usb-dac",
    uid: "{0.0.0.00000000}.{fiio-ka13-usb-dac}",
    name: "FiiO USB DAC-E10 (桌面解码耳放)",
    type: "output",
    isInput: false,
    isOutput: true,
    isDefault: false,
    isCommunicationDefault: false,
    volume: 45,
    isMuted: false,
    transportType: TransportType.Usb,
    sampleRate: 96000,
    channels: 2,
    isFavourite: true,
    isHidden: false
  },
  {
    id: "in-usb-shure-mv7",
    uid: "{0.0.1.00000000}.{shure-mv7-usb-mic}",
    name: "Shure MV7 Podcast Microphone (桌面电容麦)",
    type: "input",
    isInput: true,
    isOutput: false,
    isDefault: true,
    isCommunicationDefault: true,
    volume: 85,
    isMuted: false,
    transportType: TransportType.Usb,
    sampleRate: 48000,
    channels: 1,
    isFavourite: true,
    isHidden: false
  },
  {
    id: "in-bluetooth-airpods-mic",
    uid: "{0.0.1.00000000}.{airpods-pro-in}",
    name: "AirPods Pro Hands-Free (蓝牙耳机麦克风)",
    type: "input",
    isInput: true,
    isOutput: false,
    isDefault: false,
    isCommunicationDefault: false,
    volume: 75,
    isMuted: false,
    transportType: TransportType.Bluetooth,
    sampleRate: 24000,
    channels: 1,
    isFavourite: true,
    isHidden: false
  },
  {
    id: "in-builtin-array",
    uid: "{0.0.1.00000000}.{realtek-mic-array}",
    name: "英特尔智音技术麦克风阵列 (内置麦克风)",
    type: "input",
    isInput: true,
    isOutput: false,
    isDefault: false,
    isCommunicationDefault: false,
    volume: 70,
    isMuted: true,
    transportType: TransportType.BuiltIn,
    sampleRate: 48000,
    channels: 2,
    isFavourite: false,
    isHidden: false
  }
]);

export const DEFAULT_AUDIO_COMBOS: readonly AudioComboPreset[] = Object.freeze([
  {
    id: "combo-meeting",
    name: "🎧 线上会议模式 (腾讯会议/飞书)",
    description: "输出切至 AirPods Pro 耳机，输入切至桌面电容麦并解除静音",
    outputDeviceId: "out-bluetooth-airpods",
    inputDeviceId: "in-usb-shure-mv7",
    outputVolume: 65,
    inputVolume: 90,
    muteInput: false,
    shortcut: "Alt+1"
  },
  {
    id: "combo-speaker-chill",
    name: "🔊 桌面外放影音模式 (防窃听静音麦)",
    description: "输出切至外接显示器音响，自动将输入麦克风静音保护隐私",
    outputDeviceId: "out-display-dell-4k",
    inputDeviceId: "in-builtin-array",
    outputVolume: 55,
    inputVolume: 0,
    muteInput: true,
    shortcut: "Alt+2"
  },
  {
    id: "combo-hifi-music",
    name: "🎵 Hi-Fi 沉浸听歌模式",
    description: "输出切至 USB DAC 解码耳放，音量调至 45% 黄金听感区间",
    outputDeviceId: "out-usb-dac",
    inputDeviceId: "in-usb-shure-mv7",
    outputVolume: 45,
    inputVolume: 80,
    muteInput: true,
    shortcut: "Alt+3"
  }
]);

export function clampVolume(volume: number): number {
  if (typeof volume !== "number" || !Number.isFinite(volume)) {
    throw new Error("音量值必须为有效数字");
  }
  return Math.max(0, Math.min(100, Math.round(volume)));
}

/**
 * 构建底层平台音频切换/调音命令（支持 Windows AudioDeviceCmdlets / CoreAudio 与 macOS SwitchAudioSource）
 */
export function buildAudioPlatformCommand(
  action: "switch" | "volume" | "mute",
  device: AudioDevice,
  platform: AudioPlatform = "Windows",
  value?: number | boolean
): AudioPlatformCommand {
  const safeName = device.name.replace(/"/g, '\\"');
  if (platform === "Windows") {
    if (action === "switch") {
      const cmd = `Set-AudioDevice -ID "${device.uid}"`;
      return {
        platform: "Windows",
        executable: "powershell.exe",
        args: ["-NoProfile", "-Command", cmd],
        commandLine: `powershell.exe -NoProfile -Command "${cmd}"`,
        description: `Windows CoreAudio 切换默认${device.type === "output" ? "输出" : "输入"}设备为 ${device.name}`
      };
    }
    if (action === "volume") {
      const vol = clampVolume(typeof value === "number" ? value : device.volume);
      const prop = device.type === "output" ? "-PlaybackVolume" : "-RecordingVolume";
      const cmd = `Set-AudioDevice ${prop} ${vol}`;
      return {
        platform: "Windows",
        executable: "powershell.exe",
        args: ["-NoProfile", "-Command", cmd],
        commandLine: `powershell.exe -NoProfile -Command "${cmd}"`,
        description: `设置 ${device.name} 音量为 ${vol}%`
      };
    }
    const muteFlag = Boolean(value) ? "1" : "0";
    const prop = device.type === "output" ? "-PlaybackMute" : "-RecordingMute";
    const cmd = `Set-AudioDevice ${prop} ${muteFlag}`;
    return {
      platform: "Windows",
      executable: "powershell.exe",
      args: ["-NoProfile", "-Command", cmd],
      commandLine: `powershell.exe -NoProfile -Command "${cmd}"`,
      description: `${Boolean(value) ? "静音" : "取消静音"} ${device.name}`
    };
  }

  // macOS SwitchAudioSource / osascript
  if (action === "switch") {
    return {
      platform: "macOS",
      executable: "SwitchAudioSource",
      args: ["-t", device.type, "-s", device.name],
      commandLine: `SwitchAudioSource -t ${device.type} -s "${safeName}"`,
      description: `macOS CoreAudio 切换默认${device.type === "output" ? "输出" : "输入"}设备为 ${device.name}`
    };
  }
  if (action === "volume") {
    const vol = clampVolume(typeof value === "number" ? value : device.volume);
    const osa =
      device.type === "output"
        ? `set volume output volume ${vol}`
        : `set volume input volume ${vol}`;
    return {
      platform: "macOS",
      executable: "osascript",
      args: ["-e", osa],
      commandLine: `osascript -e '${osa}'`,
      description: `设置 ${device.name} 音量为 ${vol}%`
    };
  }
  const osa = `set volume ${Boolean(value) ? "with" : "without"} output muted`;
  return {
    platform: "macOS",
    executable: "osascript",
    args: ["-e", osa],
    commandLine: `osascript -e '${osa}'`,
    description: `${Boolean(value) ? "静音" : "取消静音"} ${device.name}`
  };
}

export class AudioDeviceManager {
  private devices: AudioDevice[];
  private combos: AudioComboPreset[];
  private platform: AudioPlatform;

  constructor(
    initialDevices: readonly AudioDevice[] = INITIAL_AUDIO_DEVICES,
    initialCombos: readonly AudioComboPreset[] = DEFAULT_AUDIO_COMBOS,
    platform: AudioPlatform = "Windows"
  ) {
    this.devices = initialDevices.map((d) => ({ ...d }));
    this.combos = initialCombos.map((c) => ({ ...c }));
    this.platform = platform;
  }

  public getAllDevices(): AudioDevice[] {
    return this.devices.map((d) => ({ ...d }));
  }

  public getOutputDevices(): AudioDevice[] {
    return this.devices.filter((d) => d.type === "output").map((d) => ({ ...d }));
  }

  public getInputDevices(): AudioDevice[] {
    return this.devices.filter((d) => d.type === "input").map((d) => ({ ...d }));
  }

  public getDefaultOutputDevice(): AudioDevice | undefined {
    const found =
      this.devices.find((d) => d.type === "output" && d.isDefault) ||
      this.devices.find((d) => d.type === "output");
    return found ? { ...found } : undefined;
  }

  public getDefaultInputDevice(): AudioDevice | undefined {
    const found =
      this.devices.find((d) => d.type === "input" && d.isDefault) ||
      this.devices.find((d) => d.type === "input");
    return found ? { ...found } : undefined;
  }

  public getCombos(): AudioComboPreset[] {
    return this.combos.map((c) => ({ ...c }));
  }

  public filterDevices(options: AudioFilterOptions = {}): AudioDevice[] {
    const ioType = options.ioType || "all";
    const transport = options.transportType || "all";
    const includeHidden = options.includeHidden ?? false;
    const q = (options.query || "").trim().toLowerCase();

    return this.devices
      .filter((d) => {
        if (!includeHidden && d.isHidden) return false;
        if (ioType === "output" && d.type !== "output") return false;
        if (ioType === "input" && d.type !== "input") return false;
        if (ioType === "favourites" && !d.isFavourite) return false;
        if (transport !== "all" && d.transportType !== transport) return false;
        if (!q) return true;
        return `${d.name} ${d.transportType} ${d.type}`.toLowerCase().includes(q);
      })
      .map((d) => ({ ...d }));
  }

  public setDefaultDevice(deviceId: string): AudioActionResult {
    const cleanId = (deviceId || "").trim();
    const target = this.devices.find((d) => d.id === cleanId || d.uid === cleanId);
    if (!target) {
      return {
        success: false,
        action: "switch-default",
        error: `未找到指定的音频设备: "${cleanId}"`
      };
    }

    for (const dev of this.devices) {
      if (dev.type === target.type) {
        dev.isDefault = dev.id === target.id;
        dev.isCommunicationDefault = dev.id === target.id;
      }
    }

    const command = buildAudioPlatformCommand("switch", target, this.platform);
    return {
      success: true,
      action: "switch-default",
      device: { ...target },
      command
    };
  }

  public setDeviceVolume(deviceId: string, volume: number): AudioActionResult {
    const cleanId = (deviceId || "").trim();
    const target = this.devices.find((d) => d.id === cleanId || d.uid === cleanId);
    if (!target) {
      return {
        success: false,
        action: "set-volume",
        error: `未找到指定的音频设备: "${cleanId}"`
      };
    }

    let clamped: number;
    try {
      clamped = clampVolume(volume);
    } catch (e: any) {
      return {
        success: false,
        action: "set-volume",
        error: e?.message || "无效的音量参数"
      };
    }

    target.volume = clamped;
    if (clamped > 0 && target.isMuted) {
      target.isMuted = false;
    }

    const command = buildAudioPlatformCommand("volume", target, this.platform, clamped);
    return {
      success: true,
      action: "set-volume",
      device: { ...target },
      command
    };
  }

  public stepDeviceVolume(deviceId: string, delta: number): AudioActionResult {
    const target = this.devices.find((d) => d.id === deviceId || d.uid === deviceId);
    if (!target) {
      return {
        success: false,
        action: "step-volume",
        error: `未找到音频设备: "${deviceId}"`
      };
    }
    const nextVol = clampVolume(target.volume + (Number.isFinite(delta) ? delta : 0));
    const res = this.setDeviceVolume(target.id, nextVol);
    return {
      ...res,
      action: "step-volume"
    };
  }

  public toggleDeviceMute(deviceId: string, forceState?: boolean): AudioActionResult {
    const target = this.devices.find((d) => d.id === deviceId || d.uid === deviceId);
    if (!target) {
      return {
        success: false,
        action: "toggle-mute",
        error: `未找到音频设备: "${deviceId}"`
      };
    }

    target.isMuted = forceState !== undefined ? Boolean(forceState) : !target.isMuted;
    const command = buildAudioPlatformCommand("mute", target, this.platform, target.isMuted);
    return {
      success: true,
      action: "toggle-mute",
      device: { ...target },
      command
    };
  }

  public toggleFavourite(deviceId: string): AudioActionResult {
    const target = this.devices.find((d) => d.id === deviceId || d.uid === deviceId);
    if (!target) {
      return {
        success: false,
        action: "toggle-favourite",
        error: `未找到音频设备: "${deviceId}"`
      };
    }
    target.isFavourite = !target.isFavourite;
    return {
      success: true,
      action: "toggle-favourite",
      device: { ...target }
    };
  }

  public applyComboPreset(comboId: string): AudioActionResult {
    const combo = this.combos.find((c) => c.id === comboId);
    if (!combo) {
      return {
        success: false,
        action: "apply-combo",
        error: `未找到音频场景预设: "${comboId}"`
      };
    }

    const outRes = this.setDefaultDevice(combo.outputDeviceId);
    if (!outRes.success) {
      return {
        success: false,
        action: "apply-combo",
        error: outRes.error
      };
    }
    if (combo.outputVolume !== undefined) {
      this.setDeviceVolume(combo.outputDeviceId, combo.outputVolume);
    }

    const inRes = this.setDefaultDevice(combo.inputDeviceId);
    if (!inRes.success) {
      return {
        success: false,
        action: "apply-combo",
        error: inRes.error
      };
    }
    if (combo.inputVolume !== undefined) {
      this.setDeviceVolume(combo.inputDeviceId, combo.inputVolume);
    }
    if (combo.muteInput !== undefined) {
      this.toggleDeviceMute(combo.inputDeviceId, combo.muteInput);
    }

    return {
      success: true,
      action: "apply-combo",
      combo: { ...combo },
      device: this.getDefaultOutputDevice()
    };
  }

  public resetToDefaults(): void {
    this.devices = INITIAL_AUDIO_DEVICES.map((d) => ({ ...d }));
    this.combos = DEFAULT_AUDIO_COMBOS.map((c) => ({ ...c }));
  }
}

export const defaultAudioDeviceManager = new AudioDeviceManager();

// Raycast 原版 `audio-device.ts` 兼容导出函数
export async function getAllDevices(): Promise<AudioDevice[]> {
  return defaultAudioDeviceManager.getAllDevices();
}

export async function getInputDevices(): Promise<AudioDevice[]> {
  return defaultAudioDeviceManager.getInputDevices();
}

export async function getOutputDevices(): Promise<AudioDevice[]> {
  return defaultAudioDeviceManager.getOutputDevices();
}

export async function getDefaultOutputDevice(): Promise<AudioDevice | undefined> {
  return defaultAudioDeviceManager.getDefaultOutputDevice();
}

export async function getDefaultInputDevice(): Promise<AudioDevice | undefined> {
  return defaultAudioDeviceManager.getDefaultInputDevice();
}

export async function setDefaultOutputDevice(deviceId: string): Promise<AudioActionResult> {
  return defaultAudioDeviceManager.setDefaultDevice(deviceId);
}

export async function setDefaultInputDevice(deviceId: string): Promise<AudioActionResult> {
  return defaultAudioDeviceManager.setDefaultDevice(deviceId);
}

export async function setOutputDeviceVolume(deviceId: string, volume: number): Promise<AudioActionResult> {
  return defaultAudioDeviceManager.setDeviceVolume(deviceId, volume);
}

export async function toggleOutputDeviceMute(deviceId: string): Promise<AudioActionResult> {
  return defaultAudioDeviceManager.toggleDeviceMute(deviceId);
}

export async function setInputDeviceVolume(deviceId: string, volume: number): Promise<AudioActionResult> {
  return defaultAudioDeviceManager.setDeviceVolume(deviceId, volume);
}

export async function toggleInputDeviceMute(deviceId: string): Promise<AudioActionResult> {
  return defaultAudioDeviceManager.toggleDeviceMute(deviceId);
}
