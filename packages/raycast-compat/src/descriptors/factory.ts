import { VIEW_DESCRIPTOR_SYMBOL, ViewDescriptor } from "./types.js";

/**
 * 校验一个对象是否为有效的 ViewDescriptor
 */
export function isViewDescriptor(obj: unknown): obj is ViewDescriptor {
  return typeof obj === "object" && obj !== null && (obj as any).$$typeof === VIEW_DESCRIPTOR_SYMBOL;
}

/**
 * 扁平化并清洗 children 节点
 */
export function normalizeChildren(children: any): ViewDescriptor[] {
  const result: ViewDescriptor[] = [];

  function walk(item: any) {
    if (item === null || item === undefined || typeof item === "boolean") {
      return;
    }
    if (Array.isArray(item)) {
      for (const sub of item) {
        walk(sub);
      }
      return;
    }
    if (isViewDescriptor(item)) {
      result.push(item);
    } else if (typeof item === "object" && typeof item.type === "function") {
      // 如果传递的是 React 风格的元素 { type: Component, props: ... }
      try {
        const rendered = item.type(item.props || {});
        walk(rendered);
      } catch {
        // ignore
      }
    }
  }

  walk(children);
  return result;
}

/**
 * 递归解析属性中的描述符或 ReactElement（如 props.actions, props.searchBarAccessory 等）
 */
export function resolveDescriptorValue(val: any): any {
  if (val === null || val === undefined || typeof val !== "object") {
    return val;
  }
  if (isViewDescriptor(val)) {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(resolveDescriptorValue);
  }
  // 如果是 React Element 风格的对象 { type: Component, props: ... }
  if (typeof (val as any).type === "function") {
    try {
      const rendered = (val as any).type((val as any).props || {});
      return resolveDescriptorValue(rendered);
    } catch {
      return val;
    }
  }
  // 普通纯对象，递归深拷贝并规范化内部可能挂载的描述符
  if (val.constructor === Object) {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === "children") continue;
      res[k] = resolveDescriptorValue(v);
    }
    return res;
  }
  return val;
}

/**
 * 创建 ViewDescriptor 虚拟视图描述符工厂函数
 */
export function createDescriptor<TProps = Record<string, any>>(
  type: string,
  rawProps?: TProps | null,
  ...explicitChildren: any[]
): ViewDescriptor<TProps> {
  const propsCopy = { ...(rawProps || {}) } as any;
  const key = propsCopy.key;
  delete propsCopy.key;

  // children 可以来自 props.children，也可以来自剩余参数
  const incomingChildren = explicitChildren.length > 0 ? explicitChildren : propsCopy.children;
  delete propsCopy.children;

  const children = normalizeChildren(incomingChildren);

  // 递归解析并规范化 props 内部可能挂载的描述符/组件元素
  const resolvedProps: Record<string, any> = {};
  for (const [k, v] of Object.entries(propsCopy)) {
    resolvedProps[k] = resolveDescriptorValue(v);
  }

  return Object.freeze({
    $$typeof: VIEW_DESCRIPTOR_SYMBOL,
    type,
    props: Object.freeze(resolvedProps as TProps),
    children: Object.freeze(children),
    key: key !== undefined ? String(key) : undefined
  });
}

/**
 * 兼容 React JSX/TSX 转换的 createElement 工厂
 */
export function createElement(type: any, props?: any, ...children: any[]): any {
  if (typeof type === "function") {
    const combinedProps = { ...(props || {}) };
    if (children.length > 0) {
      combinedProps.children = children.length === 1 ? children[0] : children;
    }
    return type(combinedProps, ...children);
  }
  return createDescriptor(String(type), props, ...children);
}

/**
 * 兼容 React Fragment
 */
export function Fragment(props?: { children?: any }): any {
  return normalizeChildren(props?.children);
}
