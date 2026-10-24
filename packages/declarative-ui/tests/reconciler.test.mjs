import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  useState,
  useEffect,
  useMemo,
  useRef,
  List
} from "../dist/index.js";

describe("Declarative Reactive Reconciler & Hooks", () => {
  test("视图树 JSON 不变、只有回调闭包变化时：不发 onUpdate，但发 onRenderEmpty 且 getLatest 返回新闭包", async () => {
    let setSelected = null;
    let updates = 0;
    let empties = 0;
    function Cmd() {
      const [selected, setSel] = useState("a");
      setSelected = setSel;
      // selected 只在回调里用到，序列化后的视图树不变
      return List({ filterBar: { actions: [{ id: "x", title: "执行", onAction: () => selected }] } }, []);
    }
    const root = renderDeclarativeRoot(Cmd, {
      onUpdate: () => { updates++; },
      onRenderEmpty: () => { empties++; }
    });
    const first = root.getLatest();
    assert.equal(first.props.filterBar.actions[0].onAction(), "a");
    updates = 0; // 首帧会通知一次 onUpdate
    setSelected("b");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(updates, 0, "JSON 相同不应通知 onUpdate");
    assert.equal(empties, 1, "应通知 onRenderEmpty，宿主据此刷新回调");
    const latest = root.getLatest();
    assert.notEqual(latest, first);
    assert.equal(latest.props.filterBar.actions[0].onAction(), "b");
    // 首帧对象里的闭包仍是旧的：宿主必须用 getLatest 刷新，不能一直持有首帧
    assert.equal(first.props.filterBar.actions[0].onAction(), "a");
    root.unmount();
  });

  test("renderDeclarativeRoot should execute component and return latest descriptor", () => {
    function SimpleCommand() {
      return List({ searchBarPlaceholder: "Search here" }, []);
    }

    const root = renderDeclarativeRoot(SimpleCommand);
    const descriptor = root.getLatest();
    assert.equal(descriptor.type, "List");
    assert.equal(descriptor.props.searchBarPlaceholder, "Search here");
    root.unmount();
  });

  test("useState should trigger re-render and generate updated descriptors", async () => {
    let updateCount = 0;
    let externalSetCount = null;

    function CounterCommand() {
      const [count, setCount] = useState(0);
      externalSetCount = setCount;

      return List({
        searchBarPlaceholder: `Count: ${count}`
      }, []);
    }

    const root = renderDeclarativeRoot(CounterCommand, {
      onUpdate: (desc) => {
        updateCount++;
      }
    });

    assert.equal(root.getLatest().props.searchBarPlaceholder, "Count: 0");

    // 更新状态
    externalSetCount(5);

    // 等待 microtask
    await new Promise((r) => queueMicrotask(r));

    assert.equal(root.getLatest().props.searchBarPlaceholder, "Count: 5");
    assert.equal(updateCount, 2); // 1 次首屏渲染 + 1 次响应式状态更新

    root.unmount();
  });

  test("useEffect should run on mount, on dependency change and clean up on unmount", async () => {
    let effectRanCount = 0;
    let cleanupRanCount = 0;
    let externalSetVal = null;

    function EffectCommand() {
      const [val, setVal] = useState("a");
      externalSetVal = setVal;

      useEffect(() => {
        effectRanCount++;
        return () => {
          cleanupRanCount++;
        };
      }, [val]);

      return List({}, []);
    }

    const root = renderDeclarativeRoot(EffectCommand);
    assert.equal(effectRanCount, 1);
    assert.equal(cleanupRanCount, 0);

    // 改变依赖
    externalSetVal("b");
    await new Promise((r) => queueMicrotask(r));

    assert.equal(effectRanCount, 2);
    assert.equal(cleanupRanCount, 1);

    // 卸载
    root.unmount();
    assert.equal(cleanupRanCount, 2);
  });

  test("useMemo, useRef should maintain stable values across renders", async () => {
    let renders = 0;
    let externalTrigger = null;
    let memoComputes = 0;

    function MemoRefCommand() {
      const [, setTick] = useState(0);
      externalTrigger = () => setTick((t) => t + 1);
      renders++;

      const memoVal = useMemo(() => {
        memoComputes++;
        return "expensive_result";
      }, []); // 空依赖

      const counterRef = useRef(100);

      return List({
        searchBarPlaceholder: `${memoVal}_${counterRef.current}_${renders}`
      }, []);
    }

    const root = renderDeclarativeRoot(MemoRefCommand);
    assert.equal(root.getLatest().props.searchBarPlaceholder, "expensive_result_100_1");
    assert.equal(memoComputes, 1);

    externalTrigger();
    await new Promise((r) => queueMicrotask(r));

    assert.equal(root.getLatest().props.searchBarPlaceholder, "expensive_result_100_2");
    assert.equal(memoComputes, 1); // 记忆化保持，不重复计算

    root.unmount();
  });
});
