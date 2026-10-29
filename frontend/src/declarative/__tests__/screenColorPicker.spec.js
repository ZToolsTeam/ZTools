import { describe, it, expect } from 'vitest';
import { createScreenColorPicker } from '../screenColorPicker.js';

describe('宿主交互取色', () => {
  it('只在选点完成后返回色值', async () => {
    let finish;
    const picker = createScreenColorPicker(() => class { open() { return new Promise(resolve => { finish = resolve; }); } });
    const pending = picker.pick();
    await expect(picker.pick()).rejects.toThrow('正在进行');
    finish({ sRGBHex: '#abcdef' });
    await expect(pending).resolves.toEqual({ hex: '#ABCDEF' });
  });
  it('退出清栈会取消取色；取消后可再次打开', async () => {
    const picker = createScreenColorPicker(() => class {
      open({ signal }) { return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    });
    const pending = expect(picker.pick()).rejects.toMatchObject({ name: 'AbortError' });
    picker.cancel(); await pending;
    const next = expect(picker.pick()).rejects.toMatchObject({ name: 'AbortError' });
    picker.cancel(); await next;
  });
  it('取消、无用户手势与系统失败原样传播，不产生颜色', async () => {
    for (const name of ['AbortError', 'NotAllowedError', 'OperationError']) {
      const picker = createScreenColorPicker(() => class { open() { return Promise.reject(new DOMException('拒绝', name)); } });
      await expect(picker.pick()).rejects.toMatchObject({ name });
      await expect(picker.pick()).rejects.toMatchObject({ name });
    }
  });
  it('不支持或返回无效颜色时如实失败', async () => {
    await expect(createScreenColorPicker(() => undefined).pick()).rejects.toThrow('不支持');
    for (const value of [null, {}, { sRGBHex: '#bad' }, { sRGBHex: 123 }]) {
      const picker = createScreenColorPicker(() => class { open() { return Promise.resolve(value); } });
      await expect(picker.pick()).rejects.toThrow('有效颜色');
    }
  });
});
