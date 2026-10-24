export type WindowAction =
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'always_on_top'
  | 'snap'
  | 'focus'
  | 'get_state';

export type WindowSnapDirection = 'left' | 'right' | 'top' | 'bottom';

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMinimized: boolean;
  isMaximized: boolean;
  isAlwaysOnTop: boolean;
  isFocused: boolean;
}

export interface WindowAdapter {
  getState(): Promise<WindowState>;
  minimize(): Promise<WindowState>;
  maximize(): Promise<WindowState>;
  restore(): Promise<WindowState>;
  setAlwaysOnTop(flag: boolean): Promise<WindowState>;
  snap(direction: WindowSnapDirection): Promise<WindowState>;
  focus(): Promise<WindowState>;
}

class DefaultWindowAdapter implements WindowAdapter {
  private state: WindowState = {
    x: 100,
    y: 100,
    width: 1024,
    height: 768,
    isMinimized: false,
    isMaximized: false,
    isAlwaysOnTop: false,
    isFocused: true
  };

  private prevBounds = { ...this.state };

  public async getState(): Promise<WindowState> {
    return { ...this.state };
  }

  public async minimize(): Promise<WindowState> {
    this.state.isMinimized = true;
    this.state.isFocused = false;
    return { ...this.state };
  }

  public async maximize(): Promise<WindowState> {
    if (!this.state.isMaximized) {
      this.prevBounds = { ...this.state };
    }
    this.state.x = 0;
    this.state.y = 0;
    this.state.width = 1920;
    this.state.height = 1080;
    this.state.isMaximized = true;
    this.state.isMinimized = false;
    this.state.isFocused = true;
    return { ...this.state };
  }

  public async restore(): Promise<WindowState> {
    this.state.x = this.prevBounds.x;
    this.state.y = this.prevBounds.y;
    this.state.width = this.prevBounds.width;
    this.state.height = this.prevBounds.height;
    this.state.isMinimized = false;
    this.state.isMaximized = false;
    this.state.isFocused = true;
    return { ...this.state };
  }

  public async setAlwaysOnTop(flag: boolean): Promise<WindowState> {
    this.state.isAlwaysOnTop = flag;
    return { ...this.state };
  }

  public async snap(direction: WindowSnapDirection): Promise<WindowState> {
    this.state.isMinimized = false;
    this.state.isMaximized = false;
    this.state.isFocused = true;

    const screenWidth = 1920;
    const screenHeight = 1080;

    switch (direction) {
      case 'left':
        this.state.x = 0;
        this.state.y = 0;
        this.state.width = Math.floor(screenWidth / 2);
        this.state.height = screenHeight;
        break;
      case 'right':
        this.state.x = Math.floor(screenWidth / 2);
        this.state.y = 0;
        this.state.width = Math.floor(screenWidth / 2);
        this.state.height = screenHeight;
        break;
      case 'top':
        this.state.x = 0;
        this.state.y = 0;
        this.state.width = screenWidth;
        this.state.height = Math.floor(screenHeight / 2);
        break;
      case 'bottom':
        this.state.x = 0;
        this.state.y = Math.floor(screenHeight / 2);
        this.state.width = screenWidth;
        this.state.height = Math.floor(screenHeight / 2);
        break;
    }

    return { ...this.state };
  }

  public async focus(): Promise<WindowState> {
    this.state.isFocused = true;
    this.state.isMinimized = false;
    return { ...this.state };
  }
}

let activeWindowAdapter: WindowAdapter = new DefaultWindowAdapter();

export function setWindowAdapter(adapter: WindowAdapter): void {
  activeWindowAdapter = adapter;
}

export function getWindowAdapter(): WindowAdapter {
  return activeWindowAdapter;
}

export interface ManageWindowArgs {
  action: WindowAction;
  options?: {
    alwaysOnTop?: boolean;
    snapTo?: WindowSnapDirection;
  };
}

export interface ManageWindowResult {
  action: WindowAction;
  success: boolean;
  state: WindowState;
}

export async function manageWindow(args: ManageWindowArgs): Promise<ManageWindowResult> {
  const { action, options } = args;

  let state: WindowState;
  switch (action) {
    case 'get_state':
      state = await activeWindowAdapter.getState();
      break;
    case 'minimize':
      state = await activeWindowAdapter.minimize();
      break;
    case 'maximize':
      state = await activeWindowAdapter.maximize();
      break;
    case 'restore':
      state = await activeWindowAdapter.restore();
      break;
    case 'always_on_top': {
      const flag = options?.alwaysOnTop !== undefined ? options.alwaysOnTop : !(await activeWindowAdapter.getState()).isAlwaysOnTop;
      state = await activeWindowAdapter.setAlwaysOnTop(flag);
      break;
    }
    case 'snap': {
      const snapDirection = options?.snapTo || 'left';
      state = await activeWindowAdapter.snap(snapDirection);
      break;
    }
    case 'focus':
      state = await activeWindowAdapter.focus();
      break;
    default:
      throw new Error(`Unsupported window action: "${action}"`);
  }

  return {
    action,
    success: true,
    state
  };
}
