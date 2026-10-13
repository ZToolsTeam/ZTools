import { getDeclarativeBridge } from "./bridge.js";

export interface NavigationHandler {
  push: (target: any) => void;
  pop: () => void;
}

let activeNavigation: NavigationHandler | null = null;

export function setActiveNavigation(nav: NavigationHandler | null): void {
  activeNavigation = nav;
}

/**
 * useNavigation Hook
 */
export function useNavigation(): NavigationHandler {
  const bridge = getDeclarativeBridge();

  return {
    push(target: any): void {
      if (activeNavigation?.push) {
        activeNavigation.push(target);
        return;
      }
      if (bridge?.navigation?.push) {
        bridge.navigation.push(target);
        return;
      }
      console.warn("[RaycastCompat] No active navigation stack found for push");
    },
    pop(): void {
      if (activeNavigation?.pop) {
        activeNavigation.pop();
        return;
      }
      if (bridge?.navigation?.pop) {
        bridge.navigation.pop();
        return;
      }
      console.warn("[RaycastCompat] No active navigation stack found for pop");
    }
  };
}
