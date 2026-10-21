// 常量与枚举
export * from "./constants/icons.js";
export * from "./constants/colors.js";
export * from "./constants/toast.js";

// 声明式组件体系 (Virtual View Descriptors)
export * from "./descriptors/index.js";

// 核心系统 API
export * from "./api/index.js";

// 响应式微运行时
export * from "./runtime/index.js";

// 官方示例应用（JSON、二维码等已由客户端内置插件提供，不在此重复）
export * from "./examples/index.js";

// @raycast/utils 实用工具兼容层
export * from "./utils/index.js";

// React 语法与 Hooks 兼容命名空间
import { createElement, Fragment } from "./descriptors/factory.js";
import { useState, useEffect, useMemo, useCallback, useRef } from "./runtime/hooks.js";

export const React = {
  createElement,
  Fragment,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef
};

export default React;


