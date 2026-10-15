import { getDeclarativeBridge } from "./bridge.js";
let activeNavigation = null;
export function setActiveNavigation(nav) {
    activeNavigation = nav;
}
/**
 * useNavigation Hook
 */
export function useNavigation() {
    const bridge = getDeclarativeBridge();
    return {
        push(target) {
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
        pop() {
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
