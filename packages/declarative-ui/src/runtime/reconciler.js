import { DeclarativeRenderInstance } from "./context.js";
/**
 * 挂载并执行声明式根组件
 */
export function renderDeclarativeRoot(component, options) {
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
        }
    };
}
