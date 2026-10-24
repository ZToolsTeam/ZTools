import { ViewDescriptor } from "../descriptors/types.js";
import { DeclarativeRenderInstance, type CollectedPopoutState } from "./context.js";
import { NavigationHandler } from "../api/navigation.js";

export interface DeclarativeRootOptions {
  onUpdate?: (descriptor: ViewDescriptor) => void;
  onRenderEmpty?: () => void;
  onRenderEvent?: (event: { type: "renderTree"; descriptor: ViewDescriptor } | { type: "renderEmpty" }) => void;
  navigation?: NavigationHandler;
  /** 独立窗口交接的 usePopoutState 初值，见 DeclarativeRenderInstanceOptions.handoffSeed */
  handoffSeed?: Record<string, unknown> | null;
}

export interface DeclarativeRoot {
  getLatest(): ViewDescriptor;
  forceRender(): ViewDescriptor;
  unmount(): void;
  getInstance(): DeclarativeRenderInstance;
  /** 本页面 usePopoutState 登记的最新值（只含本页面，不含导航栈里推入的其他页面） */
  collectPopoutState(): CollectedPopoutState;
}

/**
 * 挂载并执行声明式根组件
 */
export function renderDeclarativeRoot(
  component: () => any,
  options?: DeclarativeRootOptions
): DeclarativeRoot {
  const instance = new DeclarativeRenderInstance(component, options);
  const initialDescriptor = instance.executeRender();

  return {
    getLatest() {
      return instance.getLatestDescriptor() || initialDescriptor;
    },
    forceRender() {
      return instance.executeRender();
    },
    unmount() {
      instance.unmount();
    },
    getInstance() {
      return instance;
    },
    collectPopoutState() {
      return instance.collectPopoutState();
    }
  };
}
