import { getDeclarativeBridge } from "./bridge.js";

export interface NavigationHandler {
  push: (target: any) => void;
  /** 宿主返回 true 表示本页面已移出栈，运行时应立即停止本轮副作用。 */
  pop: () => boolean | void;
}

let activeNavigation: NavigationHandler | null = null;

export function setActiveNavigation(nav: NavigationHandler | null): NavigationHandler | null {
  const previous = activeNavigation;
  activeNavigation = nav;
  return previous;
}

/**
 * useNavigation Hook
 */
export function useNavigation(): { push: (target: unknown) => void; pop: () => void } {
  // 导航属于创建 Hook 的页面；异步恢复或嵌套渲染不能借用另一页面的导航。
  const navigation = activeNavigation ?? getDeclarativeBridge()?.navigation;

  return {
    push(target: unknown): void {
      if (navigation?.push) {
        navigation.push(target);
        return;
      }
      console.warn("[RaycastCompat] No active navigation stack found for push");
    },
    pop(): void {
      if (navigation?.pop) {
        navigation.pop();
        return;
      }
      console.warn("[RaycastCompat] No active navigation stack found for pop");
    }
  };
}
