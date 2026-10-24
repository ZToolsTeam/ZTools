import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  usePopoutState,
  useState,
  List,
  Detail
} from "../dist/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function captureWarnings(run) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("usePopoutState：独立窗口交接状态", () => {
  test("有交接初值时优先用它，且每个 key 只用一次；没有时用 initialValue", () => {
    const seed = { text: "交接的内容", count: 0, flag: false, empty: null };
    const seen = [];
    function Cmd() {
      const [text] = usePopoutState("text", "初始");
      const [count] = usePopoutState("count", () => 42);
      const [flag] = usePopoutState("flag", true);
      const [empty] = usePopoutState("empty", "非空");
      const [other] = usePopoutState("other", "默认");
      seen.push({ text, count, flag, empty, other });
      return Detail({ markdown: text });
    }
    const root = renderDeclarativeRoot(Cmd, { handoffSeed: seed });
    // 假值（0 / false / null）也是有效的交接值，不能回落到 initialValue
    assert.deepEqual(seen.at(-1), { text: "交接的内容", count: 0, flag: false, empty: null, other: "默认" });
    // 宿主传入的对象不被改动
    assert.deepEqual(seed, { text: "交接的内容", count: 0, flag: false, empty: null });
    // 已消费：再取不到
    assert.deepEqual(root.getInstance().consumePopoutSeed("text"), { found: false });
    root.forceRender();
    assert.equal(seen.at(-1).text, "交接的内容");
    root.unmount();

    // 新实例不带交接初值：回到 initialValue
    const fresh = renderDeclarativeRoot(Cmd);
    assert.deepEqual(seen.at(-1), { text: "初始", count: 42, flag: true, empty: "非空", other: "默认" });
    fresh.unmount();
  });

  test("collectPopoutState 取的是最新值（setter 之后），并带上 paths", async () => {
    let setText = null;
    let setDir = null;
    function Cmd() {
      const [text, st] = usePopoutState("text", "a");
      const [dir, sd] = usePopoutState("dir", "", { paths: (v) => (v ? [v] : []) });
      setText = st;
      setDir = sd;
      return Detail({ markdown: `${text}|${dir}` });
    }
    const root = renderDeclarativeRoot(Cmd);
    assert.deepEqual(root.collectPopoutState(), {
      entries: [
        { key: "text", value: "a", paths: [] },
        { key: "dir", value: "", paths: [] }
      ],
      rejected: []
    });
    setText("最新");
    setDir("/Users/test/Docs");
    await tick();
    assert.deepEqual(root.collectPopoutState().entries, [
      { key: "text", value: "最新", paths: [] },
      { key: "dir", value: "/Users/test/Docs", paths: ["/Users/test/Docs"] }
    ]);
    // 函数式更新也能取到最新值
    setText((prev) => `${prev}!`);
    await tick();
    assert.equal(root.collectPopoutState().entries[0].value, "最新!");
    root.unmount();
    assert.deepEqual(root.collectPopoutState(), { entries: [], rejected: [] }, "卸载后不再登记");
  });

  test("重复 key 只登记第一个并告警一次；非法 key 按普通 useState 处理且不登记", () => {
    function Cmd() {
      const [a] = usePopoutState("dup", "first");
      const [b] = usePopoutState("dup", "second");
      const [c] = usePopoutState("", "empty-key");
      const [d] = usePopoutState("x".repeat(65), "too-long");
      const [e] = usePopoutState(123, "not-string");
      const [f] = usePopoutState("bad\u0001key", "control");
      return Detail({ markdown: [a, b, c, d, e, f].join(",") });
    }
    const { result: root, warnings } = captureWarnings(() => renderDeclarativeRoot(Cmd, {
      handoffSeed: { dup: "seeded", "": "x", ["x".repeat(65)]: "y" }
    }));
    assert.equal(root.getLatest().props.markdown, "seeded,second,empty-key,too-long,not-string,control");
    const collected = root.collectPopoutState();
    assert.deepEqual(collected.entries.map((entry) => entry.key), ["dup"]);
    assert.equal(collected.entries[0].value, "seeded");
    assert.equal(warnings.filter((w) => w.includes("重复")).length, 1);
    assert.equal(warnings.filter((w) => w.includes("key 无效")).length, 4);
    // 重新渲染不重复告警
    const again = captureWarnings(() => root.forceRender());
    assert.deepEqual(again.warnings, []);
    root.unmount();
  });

  test("paths 抛错 / 返回非数组 → 该项记入 rejected；数组里的非字符串被过滤；null 等于没有路径", () => {
    function Cmd() {
      usePopoutState("throws", "v", { paths: () => { throw new Error("boom"); } });
      usePopoutState("object", "v", { paths: () => ({ length: 1, 0: "/a" }) });
      usePopoutState("string", "v", { paths: () => "/a" });
      usePopoutState("mixed", "v", { paths: () => ["/ok", 1, null, { p: "/x" }, "/ok2"] });
      usePopoutState("nullish", "v", { paths: () => null });
      return Detail({ markdown: "x" });
    }
    const root = renderDeclarativeRoot(Cmd);
    const { result: collected } = captureWarnings(() => root.collectPopoutState());
    assert.deepEqual(collected.rejected, ["throws", "object", "string"]);
    assert.deepEqual(collected.entries, [
      { key: "mixed", value: "v", paths: ["/ok", "/ok2"] },
      { key: "nullish", value: "v", paths: [] }
    ]);
    root.unmount();
  });

  test("只属于本页面：另一个根（推入的二级页面）的登记互不影响；不用该 hook 时为空", () => {
    function Child() {
      usePopoutState("child-only", "c");
      return Detail({ markdown: "child" });
    }
    function Root() {
      usePopoutState("root-only", "r");
      return List({}, []);
    }
    const root = renderDeclarativeRoot(Root, { handoffSeed: { "child-only": "不应被根消费" } });
    const child = renderDeclarativeRoot(Child);
    assert.deepEqual(root.collectPopoutState().entries.map((e) => e.key), ["root-only"]);
    assert.deepEqual(child.collectPopoutState().entries.map((e) => [e.key, e.value]), [["child-only", "c"]]);

    function Plain() {
      const [v] = useState(1);
      return Detail({ markdown: String(v) });
    }
    const plain = renderDeclarativeRoot(Plain, { handoffSeed: { anything: 1 } });
    assert.deepEqual(plain.collectPopoutState(), { entries: [], rejected: [] });
    for (const r of [root, child, plain]) r.unmount();
  });

  test("畸形交接初值：__proto__ 键不污染原型、数组 / 非对象种子被忽略、组件外调用退化为初值", () => {
    const seed = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "c"}');
    function Cmd() {
      const [p] = usePopoutState("__proto__", "init");
      const [c] = usePopoutState("constructor", "init");
      return Detail({ markdown: JSON.stringify([p, c]) });
    }
    const root = renderDeclarativeRoot(Cmd, { handoffSeed: seed });
    assert.deepEqual(JSON.parse(root.getLatest().props.markdown), [{ polluted: true }, "c"]);
    assert.equal({}.polluted, undefined, "Object.prototype 未被污染");
    root.unmount();

    for (const bad of [["a"], "text", 42, null]) {
      function Bad() {
        const [v] = usePopoutState("0", "init");
        return Detail({ markdown: String(v) });
      }
      const r = renderDeclarativeRoot(Bad, { handoffSeed: bad });
      assert.equal(r.getLatest().props.markdown, "init");
      r.unmount();
    }

    const [outside, setOutside] = usePopoutState("k", () => "lazy");
    assert.equal(outside, "lazy");
    assert.doesNotThrow(() => setOutside("x"));
  });

  test("大量 key 与高频更新：collect 始终与最终状态一致", async () => {
    const setters = [];
    function Cmd() {
      for (let i = 0; i < 200; i++) {
        const [, set] = usePopoutState(`k${i}`, i);
        setters[i] = set;
      }
      return Detail({ markdown: "x" });
    }
    const root = renderDeclarativeRoot(Cmd);
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 200; i++) setters[i]((prev) => prev + 1);
    }
    await tick();
    const collected = root.collectPopoutState();
    assert.equal(collected.entries.length, 200);
    assert.ok(collected.entries.every((entry, i) => entry.key === `k${i}` && entry.value === i + 10));
    root.unmount();
  });
});
